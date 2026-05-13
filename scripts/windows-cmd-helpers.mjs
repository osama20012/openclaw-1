const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

export function resolvePathEnvKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function escapeForCmdExe(arg) {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

export function buildCmdExeCommandLine(command, args) {
  const escapedCommand = escapeForCmdExe(command);
  const commandLine = [escapedCommand, ...args.map(escapeForCmdExe)].join(" ");

  // cmd.exe /s /c has special quote-stripping rules. When the executable path
  // itself is quoted, e.g. C:\Program Files\nodejs\pnpm.CMD, passing only
  // "C:\Program Files\nodejs\pnpm.CMD" run build lets cmd.exe strip the command
  // quotes and attempt to execute C:\Program. Wrap the whole command line so the
  // quoted executable remains intact: ""C:\Program Files\nodejs\pnpm.CMD" run build".
  if (escapedCommand.startsWith('"')) {
    return `"${commandLine}"`;
  }

  return commandLine;
}
