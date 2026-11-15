import React from "react";

interface Props {
  children: React.ReactNode;
}

export function Layout({ children }: Props): JSX.Element {
  return (
    <html>
      <head>
        <script src="https://cdn.example.com/lib.js"></script>
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" />
      </head>
      <body>
        <embed src="/media/clock.swf" />
        {children}
      </body>
    </html>
  );
}
