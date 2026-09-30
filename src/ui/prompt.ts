/** Minimal interactive prompts on stderr: free text, yes/no, and an arrow-key menu. No dependencies. */
import { createInterface } from "node:readline";
import { style } from "./term.ts";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  text(question: string, fallback?: string): Promise<string>;
  confirm(question: string, fallback?: boolean): Promise<boolean>;
  select<T>(question: string, choices: Choice<T>[], initial?: number): Promise<T>;
}

const st = style(process.stderr);

function line(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      process.stderr.write("\n");
      process.exit(130);
    });
  });
}

export const terminalPrompter: Prompter = {
  async text(question, fallback) {
    const hint = fallback ? st.dim(` (${fallback})`) : "";
    const answer = (await line(`  ${st.cyan("?")} ${st.bold(question)}${hint} `)).trim();
    return answer || fallback || "";
  },

  async confirm(question, fallback = true) {
    const answer = (await line(`  ${st.cyan("?")} ${st.bold(question)} ${st.dim(fallback ? "(Y/n)" : "(y/N)")} `)).trim().toLowerCase();
    return answer ? answer.startsWith("y") : fallback;
  },

  async select(question, choices, initial = 0) {
    const { stdin } = process;
    if (!stdin.isTTY || !process.stderr.isTTY) {
      // Numbered fallback for dumb terminals.
      choices.forEach((c, i) => process.stderr.write(`    ${i + 1}. ${c.label}${c.hint ? st.dim(`  ${c.hint}`) : ""}\n`));
      const n = Number(await line(`  ${st.cyan("?")} ${st.bold(question)} ${st.dim(`(1-${choices.length}, default ${initial + 1})`)} `));
      return choices[Number.isInteger(n) && n >= 1 && n <= choices.length ? n - 1 : initial].value;
    }

    let index = initial;
    const labelW = Math.max(...choices.map((c) => c.label.length));
    const render = (first: boolean) => {
      let out = first ? "" : `\x1b[${choices.length}A`;
      for (const [i, c] of choices.entries()) {
        const on = i === index;
        const padded = c.label.padEnd(labelW);
        const label = on ? st.cyan(`❯ ${padded}`) : `  ${padded}`;
        out += `\x1b[2K    ${label}${c.hint ? st.dim(`  ${c.hint}`) : ""}\n`;
      }
      process.stderr.write(out);
    };
    process.stderr.write(`  ${st.cyan("?")} ${st.bold(question)} ${st.dim("(↑/↓, enter)")}\n\x1b[?25l`);
    render(true);

    return new Promise((resolve) => {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const done = (value: (typeof choices)[number]["value"] | null) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off("data", onKey);
        // Collapse the menu to one line showing the answer.
        process.stderr.write(`\x1b[${choices.length + 1}A\x1b[J\x1b[?25h`);
        if (value === null) {
          process.stderr.write("\n");
          process.exit(130);
        }
        process.stderr.write(`  ${st.green("✓")} ${st.bold(question)} ${st.cyan(choices[index].label)}\n`);
        resolve(value);
      };
      const onKey = (key: string) => {
        if (key === "\u0003" || key === "\u001b") return done(null); // ctrl-c, esc
        if (key === "\r" || key === "\n") return done(choices[index].value);
        if (key === "\u001b[A" || key === "k") index = (index - 1 + choices.length) % choices.length;
        else if (key === "\u001b[B" || key === "j") index = (index + 1) % choices.length;
        else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) index = Number(key) - 1;
        else return;
        render(false);
      };
      stdin.on("data", onKey);
    });
  },
};
