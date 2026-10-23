/** Run the configured package manager directly with Node on Windows. */
export function pnpmCommand(args: string[]): [string, string[]] {
  const cli = process.env['AEGIS_PNPM_CLI'];
  if (cli) return [process.execPath, [cli, ...args]];
  return ['pnpm', args];
}
