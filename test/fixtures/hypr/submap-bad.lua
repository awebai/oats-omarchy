-- A known-bad submap: its body calls a dispatcher that does not exist, which
-- Hyprland only finds by running the body.
dofile((os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/default/hypr/bootstrap.lua")
require("default.hypr.omarchy")

hl.unbind("SUPER + O")
o.bind("SUPER + O", "OATS", hl.dsp.submap("oats"))
hl.define_submap("oats", "reset", function()
  o.bind("T", "OATS TUI", "omarchy-launch-or-focus-tui --app-id=org.oats.tui /opt/oats-fixture/oats tui")
  hl.bind("escape", hl.dsp.no_such_dispatcher("reset"))
end)
