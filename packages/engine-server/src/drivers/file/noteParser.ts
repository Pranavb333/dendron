import {
  CONSTANTS,
  DendronError,
  DEngineClient,
  DNodeUtils,
  DStore,
  DVault,
  ErrorFactory,
  ErrorUtils,
  ERROR_SEVERITY,
  ERROR_STATUS,
  isNotUndefined,
  NoteProps,
  NotePropsDict,
  NotesCacheEntry,
  NotesCacheEntryMap,
  NoteUtils,
  SchemaUtils,
  stringifyError,
  VaultUtils,
} from "@dendronhq/common-all";
import {
  DLogger,
  genHash,
  globMatch,
  string2Note,
  vault2Path,
} from "@dendronhq/common-server";
import fs from "fs-extra";
import _ from "lodash";
import path from "path";
import { createCacheEntry } from "../../utils";
import { ParserBase } from "./parseBase";
import { NotesFileSystemCache } from "../../cache/notesFileSystemCache";
import { AnchorUtils, LinkUtils } from "../../markdown/remark/utils";

export type FileMeta = {
  // file name: eg. foo.md, name = foo
  prefix: string;
  // fpath: full path, eg: foo.md, fpath: foo.md
  fpath: string;
};
export type FileMetaDict = { [key: string]: FileMeta[] };

/**
 * Get hierarchy of each file
 * @param fpaths
 * @returns
 */
function getFileMeta(fpaths: string[]): FileMetaDict {
  const metaDict: FileMetaDict = {};
  _.forEach(fpaths, (fpath) => {
    const { name } = path.parse(fpath);
    const lvl = name.split(".").length;
    if (!_.has(metaDict, lvl)) {
      metaDict[lvl] = [];
    }
    metaDict[lvl].push({ prefix: name, fpath });
  });
  return metaDict;
}

export class NoteParser extends ParserBase {
  public cache: NotesFileSystemCache;
  private engine: DEngineClient;
  private maxNoteLength: number;

  constructor(
    public opts: {
      store: DStore;
      cache: NotesFileSystemCache;
      engine: DEngineClient;
      logger: DLogger;
      maxNoteLength: number;
    }
  ) {
    super(opts);
    this.cache = opts.cache;
    this.engine = opts.engine;
    this.maxNoteLength = opts.maxNoteLength;
  }

  async parseFiles(
    allPaths: string[],
    vault: DVault
  ): Promise<{
    notes: NoteProps[];
    cacheUpdates: NotesCacheEntryMap;
    errors: DendronError[];
  }> {
    const ctx = "parseFile";
    const fileMetaDict: FileMetaDict = getFileMeta(allPaths);
    const maxLvl = _.max(_.keys(fileMetaDict).map((e) => _.toInteger(e))) || 2;
    const notesByFname: NotePropsDict = {};
    const notesById: NotePropsDict = {};
    this.logger.info({ ctx, msg: "enter", vault });
    const cacheUpdates: { [key: string]: NotesCacheEntry } = {};
    // Keep track of which notes in cache no longer exist
    const unseenKeys = this.cache.getCacheEntryKeys();
    const errors: DendronError[] = [];

    // get root note
    if (_.isUndefined(fileMetaDict[1])) {
      throw DendronError.createFromStatus({
        status: ERROR_STATUS.NO_ROOT_NOTE_FOUND,
      });
    }
    const rootFile = fileMetaDict[1].find(
      (n) => n.fpath === "root.md"
    ) as FileMeta;
    if (!rootFile) {
      throw DendronError.createFromStatus({
        status: ERROR_STATUS.NO_ROOT_NOTE_FOUND,
      });
    }
    const rootProps = this.parseNoteProps({
      fileMeta: rootFile,
      addParent: false,
      vault,
      errors,
    });
    const rootNote = rootProps.propsList[0];
    this.logger.info({ ctx, msg: "post:parseRootNote" });
    if (!rootProps.matchHash) {
      cacheUpdates[rootNote.fname] = createCacheEntry({
        noteProps: rootNote,
        hash: rootProps.noteHash,
      });
    }
    notesByFname[rootNote.fname] = rootNote;
    notesById[rootNote.id] = rootNote;
    unseenKeys.delete(rootNote.fname);

    // get root of hiearchies
    let lvl = 2;
    let prevNodes: NoteProps[] = fileMetaDict[1]
      // don't count root node
      .filter((n) => n.fpath !== "root.md")
      .flatMap((ent) => {
        try {
          const out = this.parseNoteProps({
            fileMeta: ent,
            addParent: false,
            vault,
            errors,
          });
          const notes = out.propsList;
          unseenKeys.delete(notes[0].fname);
          if (!out.matchHash) {
            cacheUpdates[notes[0].fname] = createCacheEntry({
              noteProps: notes[0],
              hash: out.noteHash,
            });
          }
          return notes;
        } catch (err: any) {
          const dendronError = ErrorFactory.wrapIfNeeded(err);
          // A fatal error would kill the initialization
          dendronError.severity = ERROR_SEVERITY.MINOR;
          dendronError.message =
            `Failed to read ${ent.fpath} in ${vault.fsPath}: ` +
            dendronError.message;
          errors.push(dendronError);
          return;
        }
      })
      .filter(isNotUndefined);
    prevNodes.forEach((ent) => {
      DNodeUtils.addChild(rootNote, ent);
      notesByFname[ent.fname] = ent;
      notesById[ent.id] = ent;
    });
    this.logger.info({ ctx, msg: "post:parseDomainNotes" });

    // get everything else
    while (lvl <= maxLvl) {
      const currNodes: NoteProps[] = (fileMetaDict[lvl] || [])
        .filter((ent) => {
          return !globMatch(["root.*"], ent.fpath);
        })
        // eslint-disable-next-line no-loop-func
        .flatMap((ent) => {
          try {
            const resp = this.parseNoteProps({
              fileMeta: ent,
              parents: prevNodes,
              notesByFname,
              addParent: true,
              vault,
              errors,
            });
            const notes = resp.propsList;
            unseenKeys.delete(notes[0].fname);

            // this indicates that the contents of the note was different
            // then what was in the cache. need to update later ^cache-update
            if (!resp.matchHash) {
              cacheUpdates[notes[0].fname] = createCacheEntry({
                noteProps: notes[0],
                hash: resp.noteHash,
              });
            }
            // need to be inside this loop
            // deal with `src/__tests__/enginev2.spec.ts`, with stubs/ test case
            notes.forEach((ent) => {
              notesByFname[ent.fname] = ent;
              notesById[ent.id] = ent;
            });
            return notes;
          } catch (err: any) {
            const dendronError = ErrorFactory.wrapIfNeeded(err);
            // A fatal error would kill the initialization
            dendronError.severity = ERROR_SEVERITY.MINOR;
            dendronError.message =
              `Failed to read ${ent.fpath} in ${vault.fsPath}: ` +
              dendronError.message;
            errors.push(dendronError);
            return undefined;
          }
        })
        .filter(isNotUndefined);
      lvl += 1;
      prevNodes = currNodes;
    }
    this.logger.info({ ctx, msg: "post:parseAllNotes" });

    // add schemas
    const out = _.values(notesByFname);
    const domains = rootNote.children.map(
      (ent) => notesById[ent]
    ) as NoteProps[];
    const schemas = this.opts.store.schemas;
    await Promise.all(
      domains.map(async (d) => {
        return SchemaUtils.matchDomain(d, notesById, schemas);
      })
    );
    // Remove stale entries from cache
    unseenKeys.forEach((unseenKey) => {
      this.cache.drop(unseenKey);
    });

    // OPT:make async and don't wait for return
    // Skip this if we found no notes, which means vault did not initialize
    if (out.length > 0) {
      // TODO only write if there are changes
      this.cache.writeToFileSystem();
    }

    this.logger.info({ ctx, msg: "post:matchSchemas" });
    return { notes: out, cacheUpdates, errors };
  }

  /**
   *
   * @param opts
   * @returns List of all notes added. If a note has no direct parents, stub notes are added instead
   */
  parseNoteProps(opts: {
    fileMeta: FileMeta;
    notesByFname?: NotePropsDict;
    parents?: NoteProps[];
    addParent: boolean;
    createStubs?: boolean;
    vault: DVault;
    errors: DendronError[];
  }): { propsList: NoteProps[]; noteHash: string; matchHash: boolean } {
    const cleanOpts = _.defaults(opts, {
      addParent: true,
      createStubs: true,
      notesByFname: {},
      parents: [] as NoteProps[],
    });
    const { fileMeta, parents, notesByFname, vault, errors } = cleanOpts;
    const ctx = "parseNoteProps";
    this.logger.debug({ ctx, msg: "enter", fileMeta });
    const wsRoot = this.opts.store.wsRoot;
    const vpath = vault2Path({ vault, wsRoot });
    let out: NoteProps[] = [];
    let noteProps: NoteProps;
    let noteHash: string;
    let matchHash: boolean;

    // get note props
    try {
      ({
        note: noteProps,
        noteHash,
        matchHash,
      } = this.file2NoteWithCache({
        fpath: path.join(vpath, fileMeta.fpath),
        vault,
        errors,
      }));
    } catch (_err: any) {
      if (!ErrorUtils.isDendronError(_err)) {
        const err = DendronError.createFromStatus({
          status: ERROR_STATUS.BAD_PARSE_FOR_NOTE,
          severity: ERROR_SEVERITY.MINOR,
          payload: { fname: fileMeta.fpath, error: stringifyError(_err) },
          message: `${fileMeta.fpath} could not be parsed`,
        });
        this.logger.error({ ctx, err });
        throw err;
      }
      throw _err;
    }
    out.push(noteProps);

    // add parent
    if (cleanOpts.addParent) {
      const stubs = NoteUtils.addOrUpdateParents({
        note: noteProps,
        notesList: _.uniqBy(_.values(notesByFname).concat(parents), "id"),
        createStubs: cleanOpts.createStubs,
        wsRoot: this.opts.store.wsRoot,
      });
      out = out.concat(stubs.map((noteChangeEntry) => noteChangeEntry.note));
    }
    return { propsList: out, noteHash, matchHash };
  }

  private file2NoteWithCache({
    fpath,
    vault,
    toLowercase,
    errors,
  }: {
    fpath: string;
    vault: DVault;
    toLowercase?: boolean;
    errors: DendronError[];
  }): {
    note: NoteProps;
    matchHash: boolean;
    noteHash: string;
  } {
    const content = fs.readFileSync(fpath, { encoding: "utf8" });
    const { name } = path.parse(fpath);
    const sig = genHash(content);
    const cacheEntry = this.cache.get(name);
    const matchHash = cacheEntry?.hash === sig;
    const fname = toLowercase ? name.toLowerCase() : name;
    let note: NoteProps;

    // if hash matches, note hasn't changed
    if (matchHash) {
      // since we don't store the note body in the cache file, we need to re-parse the body
      const capture = content.match(/^---[\s\S]+?---/);
      if (capture) {
        const offset = capture[0].length;
        const body = content.slice(offset + 1);
        // vault can change without note changing so we need to add this
        // add `contentHash` to this signature because its not saved with note
        note = {
          ...cacheEntry.data,
          body,
          vault,
          contentHash: sig,
        };
        return { note, matchHash, noteHash: sig };
      }
    }
    // If hash is different, then we update all links and anchors ^link-anchor
    // Update cache entry as well
    note = string2Note({ content, fname, vault });
    note.contentHash = sig;
    // Link/anchor errors should be logged but not interfere with rest of parsing
    try {
      this.updateLinksAndAnchors(note);
    } catch (_err: any) {
      errors.push(ErrorFactory.wrapIfNeeded(_err));
    }
    this.cache.set(
      name,
      createCacheEntry({
        noteProps: note,
        hash: note.contentHash,
      })
    );
    return { note, matchHash, noteHash: sig };
  }

  private updateLinksAndAnchors(note: NoteProps): void {
    const ctx = "noteParser:updateLinksAndAnchors";
    // Skip finding links/anchors if note is too long
    if (
      note.body.length >=
      (this.maxNoteLength || CONSTANTS.DENDRON_DEFAULT_MAX_NOTE_LENGTH)
    ) {
      this.logger.info({
        ctx,
        msg: "Note too large, skipping",
        note: NoteUtils.toLogObj(note),
        length: note.body.length,
      });
      throw new DendronError({
        message:
          `Note "${note.fname}" in vault "${VaultUtils.getName(
            note.vault
          )}" is longer than ${
            this.maxNoteLength || CONSTANTS.DENDRON_DEFAULT_MAX_NOTE_LENGTH
          } characters, some features like backlinks may not work correctly for it. ` +
          `You may increase "maxNoteLength" in "dendron.yml" to override this warning.`,
        severity: ERROR_SEVERITY.MINOR,
      });
    }

    try {
      const links = LinkUtils.findLinks({
        note,
        engine: this.engine,
      });
      note.links = links;
    } catch (err: any) {
      const dendronError = ErrorFactory.wrapIfNeeded(err);
      dendronError.message =
        `Failed to read links in note ${note.fname}: ` + dendronError.message;
      this.logger.error({
        ctx,
        error: dendronError,
        note: NoteUtils.toLogObj(note),
      });
      throw dendronError;
    }
    try {
      const anchors = AnchorUtils.findAnchors({
        note,
      });
      note.anchors = anchors;
      return;
    } catch (err: any) {
      const dendronError = ErrorFactory.wrapIfNeeded(err);
      dendronError.message =
        `Failed to read headers or block anchors in note ${note.fname}` +
        dendronError.message;
      throw dendronError;
    }
  }
}
