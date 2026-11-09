import pc from "picocolors";

export function printBanner(version = "0.1.0") {
  const logo = `
  ██╗    ██╗██╗██████╗ ███████╗     ██████╗██╗     ██╗
  ██║    ██║██║██╔══██╗██╔════╝    ██╔════╝██║     ██║
  ██║ █╗ ██║██║██║  ██║█████╗      ██║     ██║     ██║
  ██║███╗██║██║██║  ██║██╔══╝      ██║     ██║     ██║
  ╚███╔███╔╝██║██████╔╝███████╗    ╚██████╗███████╗██║
   ╚══╝╚══╝ ╚═╝╚═════╝ ╚══════╝     ╚═════╝╚══════╝╚═╝`;

  console.log(pc.cyan(logo));
  console.log(
    `  ${pc.bold(pc.white("Wide CLI"))} ${pc.dim(`v${version}`)} - ${pc.gray("Security-First Autonomous AI Agent")}`
  );
  console.log(`  ${pc.dim("Type")} ${pc.cyan("/help")} ${pc.dim("for available commands or")} ${pc.cyan("exit")} ${pc.dim("to quit.")}\n`);
}
