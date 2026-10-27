import { stdin } from "node:process";

export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    stdin.on("error", reject);
    stdin.on("end", () => resolve(text));
  });
}

