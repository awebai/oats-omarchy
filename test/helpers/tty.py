# Runs a command in a session of its own, for the installer's tests
# (test/helpers/install-world.mjs), with or without a controlling terminal:
#
#   python3 tty.py tty  <answers-file> -- <command> [args...]
#   python3 tty.py none -- <command> [args...]
#
# "tty": a pty whose slave is the command's controlling terminal, so it can
# open /dev/tty, while its stdin, stdout and stderr stay the ones this
# process was given. The answers file is written to the pty's master, as a
# person would type it, then end-of-file (Ctrl+D, a few times over) for any
# read past them, as a closed stdin gives; what the pty echoes is drained
# and dropped.
# "none": no controlling terminal at all, so /dev/tty cannot be opened,
# whether or not the test runner has one.
#
# It exits with the command's status (128 + the signal, when one ended it).
# A SIGTERM or SIGINT to it (spawnSync's timeout) kills the command's whole
# session. Python's standard library only.
import fcntl
import os
import select
import signal
import sys
import termios


def main(argv):
    mode = argv[0]
    if mode == "tty" and argv[2] == "--":
        answers, command = open(argv[1], "rb").read(), argv[3:]
    elif mode == "none" and argv[1] == "--":
        answers, command = None, argv[2:]
    else:
        sys.exit("usage: tty.py tty <answers-file> -- <command...> | none -- <command...>")

    master = slave = None
    if mode == "tty":
        master, slave = os.openpty()
    pid = os.fork()
    if pid == 0:
        os.setsid()
        if slave is not None:
            os.close(master)
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            os.close(slave)
        try:
            os.execvp(command[0], command)
        except OSError as e:
            os.write(2, f"tty.py: {command[0]}: {e.strerror}\n".encode())
            os._exit(127)

    def end(signum, _frame):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, end)
    signal.signal(signal.SIGINT, end)

    if master is not None:
        os.write(master, answers + b"\x04" * 8)
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        if master is None:
            select.select([], [], [], 0.05)
            continue
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                os.read(master, 4096)
            except OSError:
                pass
    sys.exit(os.waitstatus_to_exitcode(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))


main(sys.argv[1:])
