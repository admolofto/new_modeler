import type { Engine, EngineConfig } from '../ai/engines';
import { el } from './dom';
import { icon } from './icons';

const STYLE = `
.ai-help { width: min(600px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); padding: 0; overflow: auto;
  background: var(--raised); color: var(--fg); border: 1px solid var(--line-2); border-radius: 14px; box-shadow: 0 20px 70px #0008;
  font: var(--fs)/1.55 var(--font); }
.ai-help::backdrop { background: #0009; }
.ai-help .help-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 18px; background: var(--raised); border-bottom: 1px solid var(--line); }
.ai-help h2 { margin: 0; font-size: 16px; font-weight: 650; }
.ai-help .help-body { display: grid; gap: 18px; padding: 18px; }
.ai-help h3 { margin: 0 0 6px; font-size: var(--fs); font-weight: 600; }
.ai-help p { margin: 6px 0 0; color: var(--fg-2); }
.ai-help ol { margin: 0; padding-left: 22px; }
.ai-help li + li { margin-top: 5px; }
.ai-help code { padding: 2px 5px; border-radius: 4px; background: var(--field); color: var(--fg); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.ai-help .providers { display: grid; gap: 8px; }
.ai-help details { border: 1px solid var(--line-2); border-radius: 8px; }
.ai-help summary { padding: 10px 12px; cursor: pointer; font-weight: 600; }
.ai-help summary .connection { float: right; margin-left: 8px; color: var(--fg-3); font-size: var(--fs-xs); font-weight: 400; }
.ai-help details[open] summary { border-bottom: 1px solid var(--line); }
.ai-help .provider-body { padding: 12px; }
.ai-help dl { display: grid; grid-template-columns: 110px 1fr; gap: 7px 12px; margin: 0; }
.ai-help dt { font-weight: 600; }
.ai-help dd { margin: 0; color: var(--fg-2); }
@media (max-width: 480px) { .ai-help summary .connection { float: none; display: block; margin-left: 16px; } .ai-help dl { grid-template-columns: 90px 1fr; } }
`;

/** A read-only guide: opening help never changes the provider, model, or conversation. */
export function mountAiHelp(parent: HTMLElement): { open(engine: Engine, config: EngineConfig | null): void } {
  const close = el('button', { class: 'btn ghost sm', 'aria-label': 'Close AI help', autofocus: true }, icon('x'), 'Close');
  const body = el('div', { class: 'help-body' });
  const dialog = el('dialog', { class: 'ai-help', 'aria-labelledby': 'ai-help-title' },
    el('div', { class: 'help-head' }, el('h2', { id: 'ai-help-title' }, 'AI setup & help'), close), body,
  );
  parent.append(el('style', {}, STYLE), dialog);
  close.addEventListener('click', () => dialog.close());
  // Keep modeling shortcuts from acting on the model while the guide has focus.
  dialog.addEventListener('keydown', (event) => event.stopPropagation());

  return { open(engine, config) {
    const provider = (id: Engine, name: string, status: string, ...content: HTMLElement[]) => el('details', { open: engine === id },
      el('summary', {}, name, el('span', { class: 'connection' }, status)), el('div', { class: 'provider-body' }, ...content),
    );
    const code = (text: string) => el('code', {}, text);
    const steps = (...items: (string | HTMLElement)[][]) => el('ol', {}, ...items.map((item) => el('li', {}, ...item)));
    body.replaceChildren(
      el('section', {}, el('h3', {}, 'Build, review, refine'),
        steps(
          ['Choose an AI in the menu at the top of the AI panel.'],
          ['Describe a piece or a change, then press Enter or Send. Use Shift+Enter for a new line.'],
          ['Review the violet preview. Accept keeps the changes; Reject discards them.'],
        ),
        el('p', {}, 'Try: “Build a 36-inch base cabinet with two drawers using 3/4-inch plywood.”'),
        el('p', {}, 'Refine a pending preview with another message, such as “Make it 30 inches wide,” before accepting it.'),
      ),
      el('section', {}, el('h3', {}, 'Connect an AI'),
        el('div', { class: 'providers' },
          provider('codex', 'Codex', !config ? 'Status unavailable' : !config.codex.available ? 'CLI not found' : config.codex.loggedIn ? 'Signed in' : 'Needs sign-in',
            steps(
              ['Open a terminal and run ', code('codex login'), '.'],
              ['Finish signing in with ChatGPT in the browser.'],
              ['Refresh the modeler and choose Codex in the AI menu.'],
            ),
            el('p', {}, 'Uses your Codex login. No separate API key is needed.'),
            el('p', {}, 'If the command is not found, install the Codex CLI on PATH or set ', code('CODEX_BIN'), ' to its executable path in ', code('.env.local'), ', then restart the dev server. Codex desktop supplies its bundled CLI when it launches the app.'),
          ),
          provider('claude-code', 'Claude Code', !config ? 'Status unavailable' : config.claudeCode.available ? 'CLI installed' : 'CLI not found',
            steps(
              ['Open a terminal and run ', code('claude'), '.'],
              ['Enter ', code('/login'), ' if you need to sign in.'],
              ['Choose Claude Code in the AI menu.'],
            ),
            el('p', {}, 'Uses your Claude Code login. No separate API key is needed.'),
            el('p', {}, 'If the command is not found, install Claude Code or set ', code('CLAUDE_CODE_BIN'), ' to its executable path in ', code('.env.local'), ', then restart the dev server.'),
          ),
          provider('api', 'API (Claude)', !config ? 'Status unavailable' : config.api.hasKey ? 'Key configured' : 'API key missing',
            steps(
              ['Copy ', code('.env.example'), ' to ', code('.env.local'), ' in the project folder, or edit your existing ', code('.env.local'), '.'],
              ['Add your Anthropic key: ', code('ANTHROPIC_API_KEY=your_key_here'), '.'],
              ['Restart the dev server with ', code('npm run dev'), ', then choose API in the AI menu.'],
            ),
            el('p', {}, 'This option uses the Claude API and is billed separately per token. The key stays in the local server.'),
          ),
        ),
      ),
      el('section', {}, el('h3', {}, 'Chat controls'), el('dl', {},
        el('dt', {}, 'Model'), el('dd', {}, 'Choose a model beside the provider menu. Default uses the provider’s configured model. Codex supplies its catalog; Claude Code offers family aliases. API and custom choices use an exact model ID supported by your account. Your choice is remembered per provider. Changing models starts a fresh AI conversation and keeps your accepted geometry.'),
        el('dt', {}, 'Camera'), el('dd', {}, 'Include the current 3D view with your next message. Numbered pins show your notes.'),
        el('dt', {}, 'Talk / M'), el('dd', {}, 'Talk while pointing at parts. Press M again to finish, then send the notes to the AI. Voice capture needs a supported browser, such as Chrome or Edge.'),
        el('dt', {}, 'Stop'), el('dd', {}, 'Stop the current request. Any changes already proposed remain available for review.'),
        el('dt', {}, 'New chat'), el('dd', {}, 'The + button starts a new AI conversation. Switching providers also starts a fresh conversation. Your accepted model stays.'),
      )),
    );
    if (!dialog.open) dialog.showModal();
  } };
}
