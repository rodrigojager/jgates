import React from "react";

export function Layout({ children }) {
  return (
    <html>
      <head>
        <script src="https://cdn.example.com/lib.js"></script>
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" />
      </head>
      <body>
        <applet code="Clock.class" width="100" height="40" />
        {children}
      </body>
    </html>
  );
}
