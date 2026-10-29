// Public provenance contains no model configuration, credentials, or arbitrary environment data.
export function validWorkflowRunUrl(value) {
  if (typeof value !== 'string') return false;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})\/actions\/runs\/(\d+)$/.exec(value);
  if (!match || match[2] === '.' || match[2] === '..') return false;
  try { return new URL(value).href === value; } catch { return false; }
}

export function publicCollectionSource(env = {}) {
  const actions = env?.GITHUB_ACTIONS === 'true';
  const trigger = !actions ? 'local' : ['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ? env.GITHUB_EVENT_NAME : 'unknown';
  let runUrl = null;
  if (actions && env.GITHUB_SERVER_URL === 'https://github.com'
    && typeof env.GITHUB_REPOSITORY === 'string' && typeof env.GITHUB_RUN_ID === 'string') {
    const candidate = `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    if (validWorkflowRunUrl(candidate)) runUrl = candidate;
  }
  return { trigger, runUrl };
}

export function collectionSourceLabel(source) {
  switch (source?.trigger) {
    case 'schedule': return '定时采集';
    case 'workflow_dispatch': return '手动补采';
    case 'local': return '本地采集';
    default: return '来源未记录';
  }
}
