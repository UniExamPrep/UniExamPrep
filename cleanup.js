const { Octokit } = require('@octokit/rest');
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

async function run() {
  // Delete the 'UniExamPrep' folder in the 'GEU' repo
  const owner = 'UniExamPrep';
  const repo = 'GEU';
  const innerPath = 'UniExamPrep';
  
  console.log('Fetching tree to delete ' + innerPath);
  try {
    const { data: ref } = await octokit.git.getRef({ owner, repo, ref: 'heads/main' });
    const latestCommitSha = ref.object.sha;
    const { data: commit } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
    const baseTreeSha = commit.tree.sha;
    
    const { data: fullTree } = await octokit.git.getTree({ owner, repo, tree_sha: baseTreeSha, recursive: '1' });
    const prefix = innerPath + '/';
    const treeUpdates = [];
    
    for (const item of fullTree.tree) {
      if (item.path.startsWith(prefix) || item.path === innerPath) {
        treeUpdates.push({
          path: item.path,
          mode: '100644',
          type: item.type === 'tree' ? 'tree' : 'blob',
          sha: null,
        });
      }
    }
    
    if (treeUpdates.length === 0) {
      console.log('Nothing to delete!');
      return;
    }
    
    const { data: newTree } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: treeUpdates });
    const { data: newCommit } = await octokit.git.createCommit({ owner, repo, message: `Cleanup bad path ${innerPath}`, tree: newTree.sha, parents: [latestCommitSha] });
    await octokit.git.updateRef({ owner, repo, ref: 'heads/main', sha: newCommit.sha });
    console.log('Successfully cleaned up the bad folder!');
  } catch (e) {
    console.error(e);
  }
}

run();
