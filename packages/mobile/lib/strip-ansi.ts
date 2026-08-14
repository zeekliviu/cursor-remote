/**
 * Strip ANSI / VT control sequences for plain Text terminal views.
 * Leaves printable text + newlines/tabs; drops colors, cursor moves, OSC, etc.
 */
export function stripAnsi(input: string): string {
  return (
    input
      // OSC sequences (title, hyperlinks, …): ESC ] … BEL or ST
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
      // CSI / private modes: ESC [ … letter
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // Charset / single-char ESC sequences
      .replace(/\u001b[()][0-9A-Za-z]/g, "")
      .replace(/\u001b[=><]/g, "")
      .replace(/\u001b./g, "")
      // Bel / backspace / other C0 controls except \t \n \r
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      // Orphaned SGR fragments if ESC was lost (e.g. "[1m", "[32m", "[0m")
      .replace(/\[[\d;]*[mKJHsuABCDEFG]/g, "")
  );
}
