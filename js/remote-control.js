// Commands from our other TV apps through a Tizen message port (the Home Dashboard, HomeDash01.Dashboard, sends
// 'play-behind' when it comes to the front and 'stop-behind' when it goes away). A message is [{ key: 'cmd', value }].
// No Tizen (desktop) or a TV refusing the port: nothing listens, nothing breaks.
var RemoteControl = (function () {
  var PORT = 'kinozal.control', CMD = 'cmd';

  // handlers: { '<command>': function () -> handled? }. An unknown command is only recorded.
  function listen(handlers) {
    var mp = window.tizen && tizen.messageport;
    if (!mp || !mp.requestLocalMessagePort) return;
    mp.requestLocalMessagePort(PORT).addMessagePortListener(function (data) {
      var cmd = commandOf(data), fn = handlers.hasOwnProperty(cmd) ? handlers[cmd] : null, result = (cmd || '?') + (fn ? (fn() ? ' done' : ' ignored') : ' unknown');
      Diag.note('control', result);
      LifeLog.pinNow(fn ? 'control.' + cmd : 'control', 'control ' + result);   // D7: written at once
    });
  }

  function commandOf(data) {
    for (var i = 0; data && i < data.length; i++) if (data[i] && data[i].key === CMD) return String(data[i].value);
    return '';
  }

  return { listen: listen };
}());
