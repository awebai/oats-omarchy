Inputs for test/launch.test.mjs: `hyprctl clients -j` output in the shape
Hyprland v0.56.2 prints it (src/debug/HyprCtl.cpp, CHyprCtl::getWindowData,
joined by clientsRequest): every field, in Hyprland's order and layout. The
windows are made up: a browser, an Omarchy agent window (class
org.omarchy.agent) and, in clients-steward.json, the steward's window (class
org.omarchy.agent.oats-steward). Addresses, sizes, pids and titles are
invented; initialTitle names no terminal emulator, since no file in the
repository may (test/no-terminal-names.test.mjs).
