import { MagitChange } from '../models/magitChange';
import { workspace, window, Uri } from 'vscode';
import { magitRepositories, views } from '../extension';
import FilePathUtils from '../utils/filePathUtils';
import GitTextUtils from '../utils/gitTextUtils';
import MagitUtils from '../utils/magitUtils';
import MagitStatusView from '../views/magitStatusView';
import { Status, Commit, RefType, Repository, Change, Ref } from '../typings/git';
import { MagitBranch, MagitCommitList, MagitUpstreamRef } from '../models/magitBranch';
import { gitRun, LogLevel } from '../utils/gitRawRunner';
import * as Constants from '../common/constants';
import { getCommit } from '../utils/commitCache';
import { MagitRemote } from '../models/magitRemote';
import { MagitRebasingState } from '../models/magitRebasingState';
import { MagitMergingState } from '../models/magitMergingState';
import { MagitRevertingState } from '../models/magitRevertingState';
import { Stash } from '../models/stash';
import { MagitRepository } from '../models/magitRepository';
import ViewUtils from '../utils/viewUtils';
import { scheduleForgeStatusAsync, forgeStatusCached } from '../forge';

const maxCommitsAheadBehind = 50;

export async function magitRefresh() { }

export async function magitStatus(): Promise<any> {

  const editor = window.activeTextEditor;

  let repository = MagitUtils.getCurrentMagitRepoNO_STATUS(editor?.document.uri);

  // TODO: NB: There is special handling of repo and view here for reasons:
  //        1. The speed cheat in MagitUtils->getCurrentMagitRepo
  //        2. window->showTextDocument of the current view resulting in duplication of the view

  if (repository) {

    const uri = MagitStatusView.encodeLocation(repository);

    // Checks for existing Magit status view
    let view = views.get(uri.toString());
    if (view) {
      await MagitUtils.magitStatusAndUpdate(repository);
      if (editor?.document.uri.path === MagitStatusView.UriPath) {
        return;
      }
      return workspace.openTextDocument(view.uri).then(doc => window.showTextDocument(doc, { viewColumn: ViewUtils.showDocumentColumn(), preview: false }));
    }

    repository = await internalMagitStatus(repository.gitRepository);
    magitRepositories.set(repository.uri.fsPath, repository);

  } else {
    // TODO: Maybe call new func MagitUtils.discoverRepo_Status instead to avoid double tapping "getCurrentMagitRepoNO_STATUS"
    repository = await MagitUtils.getCurrentMagitRepo(editor?.document.uri);
  }

  if (repository) {
    scheduleForgeStatusAsync(repository);
    const uri = MagitStatusView.encodeLocation(repository);
    return ViewUtils.showView(uri, ViewUtils.createOrUpdateView(repository, uri, () => new MagitStatusView(uri, repository!)));
  }
}

export async function internalMagitStatus(repository: Repository): Promise<MagitRepository> {

  await repository.status();

  const dotGitPath = repository.rootUri + '/.git/';

  const stashTask = getStashes(repository);

  const logTask = repository.state.HEAD?.commit ? repository.log({ maxEntries: 100 }) : Promise.resolve([]);

  let ahead, behind: Promise<MagitCommitList> | undefined;

  const ref = repository.state.HEAD?.name;
  const upstream = `${ref}@{u}`;
  // We actually must have a named ref if there is "ahead"/"behind"; you can't
  // have an "upstream" without being on a named branch. So the && ref is just
  // to satisfy the type checker.
  if (repository.state.HEAD?.ahead && ref) {
    ahead = getCommitRange(repository, upstream, ref, maxCommitsAheadBehind);
  }
  if (repository.state.HEAD?.behind && ref) {
    behind = getCommitRange(repository, ref, upstream, maxCommitsAheadBehind);
  }

  const workingTreeChanges_NoUntracked = repository.state.workingTreeChanges
    .filter(c => (c.status !== Status.UNTRACKED));

  const untrackedFiles: MagitChange[] =
    repository.state.workingTreeChanges.length > workingTreeChanges_NoUntracked.length ?
      (await gitRun(repository, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory'], {}, LogLevel.None))
        .stdout
        .replace(Constants.FinalLineBreakRegex, '')
        .split(Constants.LineSplitterRegex)
        .map(untrackedPath => {
          const uri = Uri.parse(repository.rootUri.path + '/' + untrackedPath);
          return {
            originalUri: uri,
            renameUri: uri,
            uri: uri,
            status: Status.UNTRACKED,
            relativePath: FilePathUtils.uriPathRelativeTo(uri, repository.rootUri)
          };
        }) : [];

  const workingTreeChangesTasks = Promise.all(workingTreeChanges_NoUntracked
    .map(async change => {
      const diff = await repository.diffWithHEAD(change.uri.fsPath);
      return toMagitChange(repository, change, diff);
    }));

  const indexChangesTasks = Promise.all(repository.state.indexChanges
    .map(async change => {
      const diff = await repository.diffIndexWithHEAD(change.uri.fsPath);
      return toMagitChange(repository, change, diff);
    }));

  const mergeChangesTasks = Promise.all(repository.state.mergeChanges
    .map(async change => {
      const diff = await repository.diffWithHEAD(change.uri.fsPath);
      return toMagitChange(repository, change, diff);
    }));

  const sequencerTodoPath = Uri.parse(dotGitPath + 'sequencer/todo');
  const sequencerHeadPath = Uri.parse(dotGitPath + 'sequencer/head');

  const mergingStateTask = mergingStatus(repository, dotGitPath);
  const rebasingStateTask = rebasingStatus(repository, dotGitPath, logTask);
  const cherryPickingStateTask = cherryPickingStatus(repository, dotGitPath, sequencerTodoPath, sequencerHeadPath);
  const revertingStateTask = revertingStatus(repository, dotGitPath, sequencerTodoPath, sequencerHeadPath);

  const HEAD = repository.state.HEAD as MagitBranch | undefined;

  const refs = await getRefs(repository);

  if (HEAD?.commit) {
    HEAD.commitDetails = await getCommit(repository, HEAD.commit);

    HEAD.tag = refs.find(r => HEAD?.commit === r.commit && r.type === RefType.Tag);

    try {
      if (HEAD.upstream?.remote) {
        const upstreamRemote = HEAD.upstream.remote;

        const upstreamRemoteCommit = refs.find(ref => ref.remote === upstreamRemote && ref.name === `${upstreamRemote}/${HEAD.upstream?.name}`)?.commit;
        const upstreamRemoteCommitDetails = upstreamRemoteCommit ? getCommit(repository, upstreamRemoteCommit) : undefined;

        const isRebaseUpstream = repository.getConfig(`branch.${HEAD.upstream.name}.rebase`);

        HEAD.upstreamRemote = HEAD.upstream;
        HEAD.upstreamRemote.commit = await upstreamRemoteCommitDetails;
        if (ahead) {
          HEAD.upstreamRemote.ahead = await ahead;
        }
        if (behind) {
          HEAD.upstreamRemote.behind = await behind;
        }
        HEAD.upstreamRemote.rebase = (await isRebaseUpstream) === 'true';
      }
    } catch { }

    HEAD.pushRemote = await pushRemoteStatus(repository);
  }

  const remoteBranches = refs.filter(ref => ref.type === RefType.RemoteHead);

  const remotes: MagitRemote[] = repository.state.remotes.map(remote => ({
    ...remote,
    branches: remoteBranches.filter(remoteBranch =>
      remoteBranch.remote === remote.name &&
      remoteBranch.name !== remote.name + '/HEAD') // filter out uninteresting remote/HEAD element
  }));

  const forgeState = forgeStatusCached(remotes);

  return {
    uri: repository.rootUri,
    HEAD,
    stashes: await stashTask,
    log: await logTask,
    workingTreeChanges: await workingTreeChangesTasks,
    indexChanges: await indexChangesTasks,
    mergeChanges: await mergeChangesTasks,
    untrackedFiles,
    rebasingState: await rebasingStateTask,
    mergingState: await mergingStateTask,
    cherryPickingState: await cherryPickingStateTask,
    revertingState: await revertingStateTask,
    branches: refs.filter(ref => ref.type === RefType.Head),
    remotes,
    tags: refs.filter(ref => ref.type === RefType.Tag),
    refs,
    submodules: repository.state.submodules,
    gitRepository: repository,
    forgeState: forgeState,
  };
}

function toMagitChange(repository: Repository, change: Change, diff?: string): MagitChange {
  const magitChange: MagitChange = change;
  magitChange.relativePath = FilePathUtils.uriPathRelativeTo(change.uri, repository.rootUri);
  magitChange.diff = diff;
  magitChange.hunks = diff ? GitTextUtils.diffToHunks(diff, change.uri) : undefined;
  return magitChange;
}

async function getCommitRange(repository: Repository, from: string, to: string, maxResults: number): Promise<MagitCommitList> {
  const args = ['log', '--format=format:%H',  `${from}..${to}`, '-n', `${Math.trunc(maxResults) + 1}`];
  let result;
  try {
    result = await gitRun(repository, args, {}, LogLevel.Error);
  } catch (error) {
    return {commits: [], truncated: false};
  }
  const out = result.stdout.trim();
  const hashes = out ? out.split(Constants.LineSplitterRegex) : [];
  return {
    commits: await Promise.all(hashes.slice(0, maxResults).map(hash => getCommit(repository, hash))),
    truncated: hashes.length > maxResults,
  };
}

async function pushRemoteStatus(repository: Repository): Promise<MagitUpstreamRef | undefined> {
  try {
    const HEAD = repository.state.HEAD;
    const pushRemote = await repository.getConfig(`branch.${HEAD!.name}.pushRemote`);

    if (HEAD?.name && pushRemote) {

      const ahead = getCommitRange(repository, `${pushRemote}/${HEAD.name}`, HEAD.name, maxCommitsAheadBehind);
      const behind = getCommitRange(repository, HEAD.name, `${pushRemote}/${HEAD.name}`, maxCommitsAheadBehind);

      const refs = await getRefs(repository);
      const pushRemoteCommit = refs.find(ref => ref.remote === pushRemote && ref.name === `${pushRemote}/${HEAD.name}`)?.commit;
      const pushRemoteCommitDetails = pushRemoteCommit ? getCommit(repository, pushRemoteCommit) : Promise.resolve(undefined);

      return { 
        remote: pushRemote, 
        name: HEAD.name, 
        commit: await pushRemoteCommitDetails, 
        ahead: await ahead,
        behind: await behind,
      };
    }
  } catch { }
}

async function mergingStatus(repository: Repository, dotGitPath: string): Promise<MagitMergingState | undefined> {

  const mergeHeadPath = Uri.parse(dotGitPath + 'MERGE_HEAD');
  const mergeMsgPath = Uri.parse(dotGitPath + 'MERGE_MSG');

  const mergeHeadFileTask = workspace.fs.readFile(mergeHeadPath).then(f => f.toString(), err => undefined);
  const mergeMsgFileTask = workspace.fs.readFile(mergeMsgPath).then(f => f.toString(), err => undefined);

  try {
    const mergeHeadText = await mergeHeadFileTask;
    const mergeMsgText = await mergeMsgFileTask;
    if (mergeHeadText && mergeMsgText) {
      const parsedMergeState = GitTextUtils.parseMergeStatus(mergeHeadText, mergeMsgText);

      if (parsedMergeState) {
        const [mergeHeadCommit, mergingBranches] = parsedMergeState;

        const mergeCommitsText = (await gitRun(repository, ['rev-list', `HEAD..${mergeHeadCommit}`], {}, LogLevel.None)).stdout;
        const mergeCommits = mergeCommitsText
          .replace(Constants.FinalLineBreakRegex, '')
          .split(Constants.LineSplitterRegex);

        return {
          mergingBranches,
          commits: await Promise.all(mergeCommits.map(c => getCommit(repository, c)))
        };
      }
    }
  } catch { }
}

async function rebasingStatus(repository: Repository, dotGitPath: string, logTask: Promise<Commit[]>): Promise<MagitRebasingState | undefined> {
  try {

    if (repository.state.rebaseCommit) {

      let activeRebasingDirectory: Uri;
      let interactive = false;
      const rebasingDirectory = Uri.parse(dotGitPath + 'rebase-apply/');
      const interactiveRebasingDirectory = Uri.parse(dotGitPath + 'rebase-merge/');

      if (await workspace.fs.readDirectory(rebasingDirectory).then(res => res.length, err => undefined)) {
        activeRebasingDirectory = rebasingDirectory;
      } else {
        interactive = true;
        activeRebasingDirectory = interactiveRebasingDirectory;
      }

      const rebaseHeadNamePath = Uri.parse(activeRebasingDirectory + 'head-name');
      const rebaseOntoPath = Uri.parse(activeRebasingDirectory + 'onto');

      const rebaseHeadNameFileTask = workspace.fs.readFile(rebaseHeadNamePath).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''));
      const rebaseOntoPathFileTask = workspace.fs.readFile(rebaseOntoPath).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''));

      let rebaseNextIndex: number;
      let rebaseCommitListTask: Thenable<Commit[]>;

      if (interactive) {

        rebaseNextIndex = await workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-merge/msgnum'))
          .then(f => f.toString().replace(Constants.FinalLineBreakRegex, '')).then(Number.parseInt);

        rebaseCommitListTask = workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-merge/git-rebase-todo'))
          .then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined)
          .then(GitTextUtils.parseSequencerTodo).then(commits => commits.reverse());

      } else {

        const rebaseLastIndexTask = workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-apply/last')).then(f => f.toString().replace(Constants.FinalLineBreakRegex, '')).then(Number.parseInt);
        rebaseNextIndex = await workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-apply/next')).then(f => f.toString().replace(Constants.FinalLineBreakRegex, '')).then(Number.parseInt);

        const indices: number[] = [];

        for (let i = await rebaseLastIndexTask; i > rebaseNextIndex; i--) {
          indices.push(i);
        }

        rebaseCommitListTask =
          Promise.all(
            indices.map(
              index => workspace.fs.readFile(Uri.parse(dotGitPath + 'rebase-apply/' + index.toString().padStart(4, '0'))).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''))
                .then(GitTextUtils.commitDetailTextToCommit)
            ));
      }

      let ontoCommit = await getCommit(repository, await rebaseOntoPathFileTask!);
      const refs = await getRefs(repository);
      let ontoBranch = refs.find(ref => ref.commit === ontoCommit.hash && ref.type !== RefType.RemoteHead);

      let onto = {
        name: ontoBranch?.name ?? GitTextUtils.shortHash(ontoCommit.hash),
        commitDetails: ontoCommit
      };

      const doneCommits: Commit[] = (await logTask).slice(0, rebaseNextIndex - 1);
      const upcomingCommits: Commit[] = (await rebaseCommitListTask) ?? [];

      return {
        currentCommit: repository.state.rebaseCommit,
        origBranchName: (await rebaseHeadNameFileTask!).split('/')[2],
        onto,
        doneCommits,
        upcomingCommits
      };
    }
  } catch { }
}


async function cherryPickingStatus(repository: Repository, dotGitPath: string, sequencerTodoPath: Uri, sequencerHeadPath: Uri): Promise<MagitRevertingState | undefined> {
  try {

    const cherryPickHeadPath = Uri.parse(dotGitPath + 'CHERRY_PICK_HEAD');
    const cherryPickHeadCommitHash = await workspace.fs.readFile(cherryPickHeadPath).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined);

    if (cherryPickHeadCommitHash) {

      const sequencerTodoPathFileTask = workspace.fs.readFile(sequencerTodoPath)
        .then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined);
      const sequencerHeadPathFileTask = workspace.fs.readFile(sequencerHeadPath)
        .then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined);

      const todo = await sequencerTodoPathFileTask;
      const head = await sequencerHeadPathFileTask;

      const currentCommitTask = getCommit(repository, cherryPickHeadCommitHash);
      const originalHeadTask = head ? getCommit(repository, head) : getCommit(repository, repository.state.HEAD!.commit!);

      return {
        originalHead: await originalHeadTask,
        currentCommit: await currentCommitTask,
        upcomingCommits: GitTextUtils.parseSequencerTodo(todo).slice(1).reverse()
      };
    }
  } catch { }
}

async function revertingStatus(repository: Repository, dotGitPath: string, sequencerTodoPath: Uri, sequencerHeadPath: Uri): Promise<MagitRevertingState | undefined> {
  try {

    const revertHeadPath = Uri.parse(dotGitPath + 'REVERT_HEAD');
    const revertHeadCommitHash = await workspace.fs.readFile(revertHeadPath).then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined);

    if (revertHeadCommitHash) {
      const sequencerTodoPathFileTask = workspace.fs.readFile(sequencerTodoPath)
        .then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined);
      const sequencerHeadPathFileTask = workspace.fs.readFile(sequencerHeadPath)
        .then(f => f.toString().replace(Constants.FinalLineBreakRegex, ''), err => undefined);

      const todo = await sequencerTodoPathFileTask;
      const head = await sequencerHeadPathFileTask;

      const currentCommitTask = getCommit(repository, revertHeadCommitHash);
      const originalHeadTask = head ? getCommit(repository, head) : getCommit(repository, repository.state.HEAD!.commit!);

      return {
        originalHead: await originalHeadTask,
        currentCommit: await currentCommitTask,
        upcomingCommits: GitTextUtils.parseSequencerTodo(todo).slice(1).reverse()
      };
    }
  } catch { }
}

async function getStashes(repository: Repository): Promise<Stash[]> {

  let args = ['stash', 'list'];

  try {
    let stashesList = await gitRun(repository, args, {}, LogLevel.None);
    let stashOut = stashesList.stdout;

    if (stashOut.length === 0) {
      return [];
    }

    return stashOut
      .replace(Constants.FinalLineBreakRegex, '')
      .split(Constants.LineSplitterRegex)
      .map((stashLine, index) => ({ index, description: stashLine.replace(/stash@{\d+}: /g, '') }));

  } catch {
    return [];
  }
}

async function getRefs(repository: Repository): Promise<Ref[]> {
  // `repository.getRefs` is not available on older versions and we should 
  // just use `repository.state.refs` on those versions.
  if (typeof repository.getRefs !== 'function') {
    return repository.state.refs;
  }

  return await repository.getRefs({});
}