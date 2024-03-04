local wezterm = require 'wezterm'
local mux = wezterm.mux

wezterm.on('gui-startup', function(cmd)
  local tab, pane, window
  tab, pane, window = mux.spawn_window {
    args = {'bash', '-i', '-c' , 'cd '.. cmd.args[1] .. '; bash'},


  }
  tab:set_title 'missiv'
  window:set_title 'missiv'

	local pane_server = pane:split {
    args = {'bash', '-i', '-c', 'cd '.. cmd.args[1] .. '; sleep 1; pnpm server:dev; bash'},
    direction = 'Bottom'
  }
	local pane_client = pane_server:split {
    args = {'bash', '-i', '-c', 'cd '.. cmd.args[1] .. '; sleep 1; pnpm client:dev; bash'},
    direction = 'Right'
  }

  local pane_client = pane_server:split {
    args = {'bash', '-i', '-c', 'cd '.. cmd.args[1] .. '; sleep 1; pnpm types:dev; bash'},
    direction = 'Right'
  }


end)


config = {}

-- fix windows in virtualbox
config.prefer_egl=true

return config
