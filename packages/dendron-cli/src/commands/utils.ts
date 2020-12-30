import { resolvePath } from "@dendronhq/common-server";
import { DEngineClientV2, EngineConnector } from "@dendronhq/engine-server";
import { LaunchEngineServerCommand } from "./launchEngineServer";
import _ from "lodash";

export async function setupEngine(opts: {
  wsRoot: string;
  enginePort?: number;
  init?: boolean;
}) {
  let { wsRoot, enginePort, init } = _.defaults(opts, { init: true });
  let engine: DEngineClientV2;
  let port: number;
  wsRoot = resolvePath(wsRoot, process.cwd());
  if (enginePort) {
    const engineConnector = EngineConnector.getOrCreate({
      wsRoot,
    });
    await engineConnector.init({ portOverride: enginePort });
    engine = engineConnector.engine;
    port = enginePort;
  } else {
    ({ engine, port } = await new LaunchEngineServerCommand().enrichArgs(opts));
    if (init) {
      await engine.init();
    }
  }
  return { wsRoot, engine, port };
}
