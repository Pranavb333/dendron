import { DendronError, ERROR_SEVERITY } from "@dendronhq/common-all";
import {
  SyncActionResult,
  SyncActionStatus,
  WorkspaceUtils,
} from "@dendronhq/engine-server";
import _ from "lodash";
import { ProgressLocation, window } from "vscode";
import { DENDRON_COMMANDS } from "../constants";
import { ExtensionProvider } from "../ExtensionProvider";
import { Logger } from "../logger";
import { MessageSeverity, VSCodeUtils } from "../vsCodeUtils";
import { BasicCommand } from "./base";

const L = Logger;

type CommandOpts = {};
type CommandReturns =
  | {
      committed: SyncActionResult[];
      pulled: SyncActionResult[];
      pushed: SyncActionResult[];
    }
  | undefined;

export class SyncCommand extends BasicCommand<CommandOpts, CommandReturns> {
  key = DENDRON_COMMANDS.SYNC.key;

  private static generateReportMessage({
    committed,
    pulled,
    pushed,
  }: {
    committed: SyncActionResult[];
    pulled: SyncActionResult[];
    pushed: SyncActionResult[];
  }) {
    const message = ["Finished sync."];
    // Report anything unusual the user probably should know about
    let maxMessageSeverity: MessageSeverity = MessageSeverity.INFO;

    const makeMessage = (
      status: SyncActionStatus,
      results: SyncActionResult[][],
      fn: (repos: string) => {
        msg: string;
        severity: MessageSeverity;
      }
    ) => {
      const uniqResults = _.uniq(_.flattenDeep(results));
      const repos = WorkspaceUtils.getFilteredRepoNames(uniqResults, status);
      if (repos.length === 0) return;
      const { msg, severity } = fn(repos.join(", "));
      message.push(msg);
      if (severity > maxMessageSeverity) maxMessageSeverity = severity;
    };

    // Errors, sync is probably misconfigured or there's something wrong with git
    makeMessage(SyncActionStatus.CANT_STASH, [pulled], (repos) => {
      return {
        msg: `Can't pull ${repos} because there are local changes that can't be stashed.`,
        severity: MessageSeverity.ERROR,
      };
    });
    makeMessage(SyncActionStatus.NOT_PERMITTED, [pushed], (repos) => {
      return {
        msg: `Can't pull ${repos} because this user is not permitted.`,
        severity: MessageSeverity.ERROR,
      };
    });
    makeMessage(SyncActionStatus.BAD_REMOTE, [pulled, pushed], (repos) => {
      return {
        msg: `Can't pull or push ${repos} because of a connection problem. Check your internet connection, repository permissions, and credentials.`,
        severity: MessageSeverity.ERROR,
      };
    });
    // Warnings, need user interaction to continue sync
    makeMessage(
      SyncActionStatus.MERGE_CONFLICT,
      [committed, pulled, pushed],
      (repos) => {
        return {
          msg: `Skipped ${repos} because they have merge conflicts that must be resolved manually.`,
          severity: MessageSeverity.WARN,
        };
      }
    );
    makeMessage(
      SyncActionStatus.MERGE_CONFLICT_AFTER_PULL,
      [pulled],
      (repos) => {
        return {
          msg: `Pulled ${repos} but they have merge conflicts that must be resolved.`,
          severity: MessageSeverity.WARN,
        };
      }
    );
    makeMessage(
      SyncActionStatus.MERGE_CONFLICT_AFTER_RESTORE,
      [pulled],
      (repos) => {
        return {
          msg: `Pulled ${repos} but encountered merge conflicts when restoring local changes.`,
          severity: MessageSeverity.WARN,
        };
      }
    );
    makeMessage(
      SyncActionStatus.MERGE_CONFLICT_LOSES_CHANGES,
      [pulled],
      (repos) => {
        return {
          msg: `Can't pull ${repos} because there are local changes, and pulling will cause a merge conflict. You must commit your local changes first.`,
          severity: MessageSeverity.WARN,
        };
      }
    );
    makeMessage(
      SyncActionStatus.REBASE_IN_PROGRESS,
      [pulled, pushed, committed],
      (repos) => {
        return {
          msg: `Skipped ${repos} because there's a rebase in progress that must be resolved.`,
          severity: MessageSeverity.WARN,
        };
      }
    );
    makeMessage(SyncActionStatus.NO_UPSTREAM, [pulled, pushed], (repos) => {
      return {
        msg: `Skipped pulling or pushing ${repos} because they don't have upstream branches configured.`,
        severity: MessageSeverity.WARN,
      };
    });
    makeMessage(SyncActionStatus.UNPULLED_CHANGES, [pushed], (repos) => {
      return {
        msg: `Can't push ${repos} because there are unpulled changes.`,
        severity: MessageSeverity.WARN,
      };
    });

    return { message, maxMessageSeverity };
  }

  addAnalyticsPayload(_opts: CommandOpts, resp: CommandReturns) {
    const allActions = [
      ...(resp?.committed ?? []),
      ...(resp?.pulled ?? []),
      ...(resp?.pushed ?? []),
    ];

    return {
      hasMultiVaultRepo: allActions.some((action) => action.vaults.length > 1),
    };
  }

  async execute(opts?: CommandOpts) {
    const ctx = "execute";
    L.info({ ctx, opts });
    const workspaceService = ExtensionProvider.getExtension().workspaceService;
    if (_.isUndefined(workspaceService))
      throw new DendronError({
        message: "Workspace is not initialized",
        severity: ERROR_SEVERITY.FATAL,
      });
    const engine = ExtensionProvider.getEngine();

    const { committed, pulled, pushed } = await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: "Syncing Workspace",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0, message: "committing repos" });
        const committed = await workspaceService.commitAndAddAll({ engine });
        L.info(committed);
        progress.report({ increment: 25, message: "pulling repos" });
        const pulled = await workspaceService.pullVaults();
        L.info(pulled);
        progress.report({ increment: 50, message: "pushing repos" });

        const pushed = await workspaceService.pushVaults();
        progress.report({ increment: 100 });
        L.info(pushed);

        return { committed, pulled, pushed };
      }
    );

    const { message, maxMessageSeverity } = SyncCommand.generateReportMessage({
      committed,
      pulled,
      pushed,
    });

    // Successful operations
    const committedDone = WorkspaceUtils.getCountForStatusDone(committed);
    const pulledDone = WorkspaceUtils.getCountForStatusDone(pulled);
    const pushedDone = WorkspaceUtils.getCountForStatusDone(pushed);
    const repos = (count: number) => (count === 1 ? "repo" : "repos");
    message.push(`Committed ${committedDone} ${repos(committedDone)},`);
    message.push(`tried pulling ${pulledDone}`);
    message.push(`and pushing ${pushedDone} ${repos(pushedDone)}.`);
    const finalMessage = message.join(" ");

    VSCodeUtils.showMessage(maxMessageSeverity, finalMessage, {});

    return {
      committed,
      pulled,
      pushed,
      finalMessage,
    };
  }
}
