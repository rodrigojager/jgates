import React from "react";

export function Layout({ children }) {
  return (
    <html>
      <head>
        <script src="https://cdn.example.com/lib.js" integrity="sha384-abc123" crossOrigin="anonymous"></script>
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" integrity="sha384-def456" crossOrigin="anonymous" />
      </head>
      <body>
        <video src="/media/clock.mp4" width="100" height="40" controls />
        {children}
      </body>
    </html>
  );
}
