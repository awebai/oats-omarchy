-- A known-good submap, loaded the way a user's hyprland.lua loads Omarchy.
dofile((os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/default/hypr/bootstrap.lua")
require("default.hypr.omarchy")

hl.unbind("SUPER + O")
o.bind("SUPER + O", "OATS", hl.dsp.submap("oats"))
hl.define_submap("oats", "reset", function()
  o.bind("T", "OATS TUI", "omarchy-launch-or-focus-tui --app-id=org.oats.tui /opt/oats-fixture/oats tui")
  o.bind("O", "Pop window out", "omarchy-hyprland-window-pop")
  hl.bind("escape", hl.dsp.submap("reset"))
  hl.bind("catchall", hl.dsp.submap("reset"))
end)
