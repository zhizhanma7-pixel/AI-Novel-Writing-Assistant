const path = require("node:path");

function pnpmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "pnpm.cmd", ...args],
    };
  }
  return { command: "pnpm", args };
}

function sqliteDatabaseUrl(serverRoot, databasePath) {
  const relativeDatabasePath = path.relative(serverRoot, databasePath).replace(/\\/g, "/");
  if (
    relativeDatabasePath === ".."
    || relativeDatabasePath.startsWith("../")
    || path.isAbsolute(relativeDatabasePath)
  ) {
    throw new Error(`Database escaped the server root: ${databasePath}`);
  }
  return `file:./${relativeDatabasePath}`;
}

module.exports = { pnpmInvocation, sqliteDatabaseUrl };
