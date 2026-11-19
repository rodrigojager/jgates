import React from "react";

interface Props {
  title: string;
}

export function Shell({ title }: Props): JSX.Element {
  return (
    <html>
      <head>
        <title>{title}</title>
        // ruleid: jgates.js.external-script-without-integrity
        <script src="https://static.example.net/widget.js" defer></script>
        // ruleid: jgates.js.external-script-without-integrity
        <link rel="stylesheet" href="//static.example.net/widget.css" />
        // ok: jgates.js.external-script-without-integrity
        <script src="https://static.example.net/widget.js" integrity="sha384-xyz789" crossOrigin="anonymous" defer></script>
        // ok: jgates.js.external-script-without-integrity
        <link rel="stylesheet" href="https://static.example.net/widget.css" integrity="sha384-uvw012" crossOrigin="anonymous" />
        // ok: jgates.js.external-script-without-integrity
        <script src="/assets/main.js" defer></script>
      </head>
      <body>
        // ruleid: jgates.js.deprecated-plugin-content
        <applet archive="chart.jar" code="Chart.class" />
        // ruleid: jgates.js.deprecated-plugin-content
        <embed src="/media/banner.swf" />
        // ok: jgates.js.deprecated-plugin-content
        <embed src="/media/banner.svg" type="image/svg+xml" />
        // ok: jgates.js.deprecated-plugin-content
        <iframe src="/media/banner.html" title="banner" />
      </body>
    </html>
  );
}
