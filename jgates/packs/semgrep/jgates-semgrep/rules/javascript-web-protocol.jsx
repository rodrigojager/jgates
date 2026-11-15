import React from "react";

export function Page() {
  return (
    <html>
      <head>
        // ruleid: jgates.js.external-script-without-integrity
        <script src="https://cdn.example.com/lib.js"></script>
        // ruleid: jgates.js.external-script-without-integrity
        <script src="//cdn.example.com/other.js" async />
        // ruleid: jgates.js.external-script-without-integrity
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" />
        // ruleid: jgates.js.external-script-without-integrity
        <link href="https://cdn.example.com/grid.css" rel="stylesheet" />
        // ok: jgates.js.external-script-without-integrity
        <script src="https://cdn.example.com/lib.js" integrity="sha384-abc123" crossOrigin="anonymous"></script>
        // ok: jgates.js.external-script-without-integrity
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" integrity="sha384-def456" crossOrigin="anonymous" />
        // ok: jgates.js.external-script-without-integrity
        <script src="/static/app.js"></script>
        // ok: jgates.js.external-script-without-integrity
        <link rel="stylesheet" href="/static/app.css" />
      </head>
      <body>
        // ruleid: jgates.js.deprecated-plugin-content
        <applet code="Clock.class" width="100" height="40" />
        // ruleid: jgates.js.deprecated-plugin-content
        <object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000" width="400" height="300" />
        // ruleid: jgates.js.deprecated-plugin-content
        <embed src="/media/intro.swf" type="application/x-shockwave-flash" />
        // ruleid: jgates.js.deprecated-plugin-content
        <object data="/media/player.xap" width="400" height="300" />
        // ok: jgates.js.deprecated-plugin-content
        <object data="/media/report.pdf" type="application/pdf" width="400" height="300" />
        // ok: jgates.js.deprecated-plugin-content
        <video src="/media/intro.mp4" controls />
        // ok: jgates.js.deprecated-plugin-content
        <embed src="/media/diagram.svg" type="image/svg+xml" />
      </body>
    </html>
  );
}
