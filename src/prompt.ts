import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

/**
 * One interactive prompt for a command. Ctrl+C becomes the process's normal SIGINT exit and Ctrl+D (input closed)
 * rejects with "Cancelled." instead of leaving the question pending forever, which would let the process exit 0
 * without running cleanup.
 */
export class Prompt {
  private rl?: Interface;
  private readonly controller = new AbortController();
  constructor(private readonly input: NodeJS.ReadableStream = stdin, private readonly output: NodeJS.WritableStream = stderr) {}
  async ask(question: string): Promise<string> {
    if (!this.rl) {
      const rl = this.rl = createInterface({ input: this.input, output: this.output });
      rl.once('close', () => this.controller.abort());
      rl.on('SIGINT', () => { rl.close(); process.kill(process.pid, 'SIGINT'); });
    }
    if (this.controller.signal.aborted) throw new Error('Cancelled.');
    try { return (await this.rl.question(question, { signal: this.controller.signal })).trim(); }
    catch (e) { if ((e as Error)?.name === 'AbortError') throw new Error('Cancelled.'); throw e; }
  }
  close(): void { this.rl?.close(); }
}
