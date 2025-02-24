import { PgCommon } from "../common";
import { PgTerminal } from "../terminal";
import type {
  Arrayable,
  Disposable,
  Getable,
  SyncOrAsync,
  ValueOf,
} from "../types";

/** Terminal command implementation */
export type CommandImpl<N extends string, A extends Arg[], S, R> = {
  /** Name of the command that will be used in terminal */
  name: N;
  /** Description that will be seen in the `help` command */
  description: string;
  /* Only process the command if the condition passes */
  preCheck?: Arrayable<() => SyncOrAsync<void>>;
} & (WithSubcommands<S> | WithRun<A, R>);

type WithSubcommands<S> = {
  /** Command arguments */
  args?: never;
  /** Function to run when the command is called */
  run?: never;
  /** Subcommands */
  subcommands?: S;
};

type WithRun<A, R> = {
  /** Command arguments */
  args?: A;
  /** Function to run when the command is called */
  run: (input: ParsedInput<A>) => R;
  /** Subcommands */
  subcommands?: never;
};

type ParsedInput<A> = {
  /** Raw input */
  raw: string;
  /** Parsed arguments */
  args: ParsedArgs<A>;
};

/** Recursively map argument types */
type ParsedArgs<A> = A extends [infer Head, ...infer Tail]
  ? Head extends Arg<infer N, infer O, infer V>
    ? (O extends true ? { [K in N]?: V } : { [K in N]: V }) & ParsedArgs<Tail>
    : never
  : {};

/** Command argument */
export type Arg<
  N extends string = string,
  O = boolean,
  V extends string = string
> = {
  /** Name of the argument */
  name: N;
  /** Whether the argument can be omitted */
  optional?: O;
  /** Accepted values */
  values?: Getable<V[]>;
};

/** Terminal command inferred implementation */
export type CommandInferredImpl<N extends string, A extends Arg[], S, R> = Omit<
  CommandImpl<N, A, S, R>,
  "subcommands"
> & {
  subcommands?: S extends CommandInferredImpl<
    infer N2,
    infer A2,
    infer S2,
    infer R2
  >
    ? CommandInferredImpl<N2, A2, S2, R2>
    : any[];
};

/** Command type for external usage */
type Command<N extends string, A extends Arg[], S, R> = Pick<
  CommandInferredImpl<N, A, S, R>,
  "name"
> & {
  /** Command processor */
  run(args?: string): Promise<Awaited<R>>;
  /**
   * @param cb callback function to run when the command starts running
   * @returns a dispose function to clear the event
   */
  onDidRunStart(cb: (input: string | null) => void): Disposable;
  /**
   * @param cb callback function to run when the command finishes running
   * @returns a dispose function to clear the event
   */
  onDidRunFinish(cb: (result: Awaited<R>) => void): Disposable;
};

/** Name of all the available commands (only code) */
type CommandCodeName = keyof InternalCommands;

/** Ready to be used commands */
type Commands = {
  [N in keyof InternalCommands]: InternalCommands[N] extends CommandInferredImpl<
    infer N,
    infer A,
    infer S,
    infer R
  >
    ? Command<N, A, S, R>
    : never;
};

/** All commands */
export const PgCommand: Commands = new Proxy(
  {},
  {
    get: (
      target: any,
      cmdCodeName: CommandCodeName
    ): Command<string, Arg[], unknown, unknown> => {
      if (!target[cmdCodeName]) {
        const cmdUiName = PgCommandManager.commands[cmdCodeName].name;
        target[cmdCodeName] = {
          name: cmdUiName,
          run: (args = "") => {
            return PgTerminal.executeFromStr(`${cmdUiName} ${args}`, true);
          },
          onDidRunStart: (cb: (input: string | null) => void) => {
            return PgCommon.onDidChange({
              cb,
              eventName: getEventName(cmdCodeName, "start"),
            });
          },
          onDidRunFinish: (cb: (result: unknown) => void) => {
            return PgCommon.onDidChange({
              cb,
              eventName: getEventName(cmdCodeName, "finish"),
            });
          },
        };
      }

      return target[cmdCodeName];
    },
  }
);

/**
 * Terminal command manager.
 *
 * This is intended for internal usage. Running commands should be done with
 * `PgCommand` instead.
 */
export class PgCommandManager {
  /** Internal commands */
  static commands: InternalCommands;

  /**
   * Get the available command names.
   *
   * @returns the command names
   */
  static getNames() {
    return Object.values(PgCommandManager.commands).map((cmd) => cmd.name);
  }

  /**
   * Get the available command completions.
   *
   * @returns the command completions
   */
  static getCompletions() {
    interface Completions {
      [key: string]: Completions | Getable<string[]>;
    }
    const recursivelyGetCompletions = (
      commands: ValueOf<InternalCommands>[],
      completions: Completions = {}
    ) => {
      for (const cmd of commands) {
        completions[cmd.name] = {};
        const completion = completions[cmd.name] as Completions;
        if (cmd.subcommands) {
          recursivelyGetCompletions(cmd.subcommands, completion);
        } else if (cmd.args) {
          for (const i in cmd.args) {
            const arg = cmd.args[i] as Arg;
            if (arg.values) completion[i] = arg.values;
          }
        }
      }

      return completions;
    };
    return recursivelyGetCompletions(Object.values(PgCommandManager.commands));
  }

  /**
   * Execute from the given tokens.
   *
   * All command processing logic happens in this method.
   *
   * @param tokens parsed input tokens
   * @returns the return value of the command
   */
  static async execute(tokens: string[]) {
    return await PgTerminal.process(async () => {
      const inputCmdName = tokens.at(0);
      if (!inputCmdName) return;

      const topCmd = Object.values(PgCommandManager.commands).find(
        (cmd) => cmd.name === inputCmdName
      );
      if (!topCmd) {
        throw new Error(
          `Command \`${PgTerminal.italic(inputCmdName)}\` not found.`
        );
      }

      // Dispatch start event
      const input = tokens.join(" ");
      PgCommon.createAndDispatchCustomEvent(
        getEventName(topCmd.name, "start"),
        input
      );

      let cmd = topCmd;
      let args: string[] = [];

      for (const i in tokens) {
        // Get subcommand
        const token = tokens[i];
        const nextToken = tokens[+i + 1];

        const subCmd = cmd.subcommands?.find((cmd) => cmd.name === token);
        if (subCmd) cmd = subCmd;
        if (nextToken) {
          const isNextTokenSubcommand = cmd.subcommands?.some(
            (cmd) => cmd.name === nextToken
          );
          if (!isNextTokenSubcommand) {
            args = tokens.slice(+i + 1);

            if (!cmd.args && cmd.subcommands) {
              throw new Error(
                `Subcommand doesn't exist: \`${nextToken}\`

Available subcommands: ${cmd.subcommands.map((cmd) => cmd.name).join(", ")}`
              );
            }
            if (cmd.args?.length && args.length > cmd.args.length) {
              throw new Error(
                `Provided argument count is higher than expected: ${args.length}`
              );
            }
          }
        }

        // Handle checks
        if (cmd.preCheck) {
          const preChecks = PgCommon.toArray(cmd.preCheck);
          for (const preCheck of preChecks) await preCheck();
        }

        // Early continue if it's not the end of the command
        const isLast = +i === tokens.length - 1;
        if (!isLast && !args.length) continue;

        // Check missing command processor
        if (!cmd.run) {
          PgTerminal.log(`
${cmd.description}

Usage: ${[...tokens.slice(0, +i), cmd.name].join(" ")} <COMMAND>

Commands:

${formatCmdList(cmd.subcommands!)}`);
          break;
        }

        const parsedArgs: Record<string, string> = {};
        if (cmd.args) {
          for (const i in cmd.args) {
            const arg = cmd.args[i];
            const inputArg = args[i];
            if (!inputArg && !arg.optional) {
              throw new Error(`Argument not specified: \`${arg.name}\``);
            }

            parsedArgs[arg.name] = inputArg;
          }
        }

        // Run the command processor
        const result = await cmd.run({
          raw: input,
          args: parsedArgs,
        });

        // Dispatch finish event
        PgCommon.createAndDispatchCustomEvent(
          getEventName(topCmd.name, "finish"),
          result
        );

        return result;
      }
    });
  }
}

/**
 * Format the given list for terminal view.
 *
 * @param list list to format
 * @returns the formatted list
 */
export const formatCmdList = (
  list: Array<{ name: string; description: string }>
) => {
  return list
    .sort((a, b) => {
      // Put non-letter commands to the end
      if (!/^[a-zA-Z-]+$/.test(b.name)) {
        return -1;
      }

      return a.name.localeCompare(b.name);
    })
    .reduce((acc, cmd) => {
      return (
        acc +
        "    " +
        cmd.name +
        new Array(25 - cmd.name.length).fill(" ").reduce((acc, v) => acc + v) +
        cmd.description +
        "\n"
      );
    }, "");
};

/** Get custom event name for the given command. */
const getEventName = (name: string, kind: "start" | "finish") => {
  switch (kind) {
    case "start":
      return "ondidrunstart" + name;
    case "finish":
      return "ondidrunfinish" + name;
  }
};
