import readline from "node:readline/promises";
import { Writable } from "node:stream";

export interface MutedTerminalOutput {
  stream: Writable;
  setMuted(value: boolean): void;
}

/** 将输入回显与提示输出分离：提示可见，秘密字符不进入终端缓冲。 */
export function createMutedTerminalOutput(
  output: NodeJS.WritableStream = process.stdout,
): MutedTerminalOutput {
  let muted = false;
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  return {
    stream,
    setMuted: (value) => {
      muted = value;
    },
  };
}

export interface ReadSecretOptions {
  prompt: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** 显示输入提示后再关闭回显；返回值只在本机进程内短暂存在。 */
export async function readSecret({
  prompt,
  input = process.stdin,
  output = process.stdout,
}: ReadSecretOptions): Promise<string> {
  const mutedOutput = createMutedTerminalOutput(output);
  const rl = readline.createInterface({
    input,
    output: mutedOutput.stream,
    terminal: true,
  });
  try {
    output.write(`${prompt}（输入不回显）: `);
    mutedOutput.setMuted(true);
    return await rl.question("");
  } finally {
    mutedOutput.setMuted(false);
    output.write("\n");
    rl.close();
  }
}
