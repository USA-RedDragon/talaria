"use strict";
// The pairing page writes the time the computer asked in the viewer's zone,
// with the zone name. The server's UTC text stays when the time is unreadable.
(() => {
  const n = document.getElementById("asked");
  const ms = n ? Date.parse(n.getAttribute("datetime") || "") : NaN;
  if (!isFinite(ms)) return;
  n.textContent = new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(ms);
})();
