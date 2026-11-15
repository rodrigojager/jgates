import React from "react";

interface Props {
  children: React.ReactNode;
}

export function Layout({ children }: Props): JSX.Element {
  return (
    <html>
      <head>
        <script src="https://cdn.example.com/lib.js" integrity="sha384-abc123" crossOrigin="anonymous"></script>
        <link rel="stylesheet" href="https://cdn.example.com/theme.css" integrity="sha384-def456" crossOrigin="anonymous" />
      </head>
      <body>
        <video src="/media/clock.mp4" controls />
        {children}
      </body>
    </html>
  );
}
