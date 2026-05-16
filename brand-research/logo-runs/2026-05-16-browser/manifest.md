# Browser Logo Generation Run

Date: 2026-05-16

Prompt: `prompt.md`

## Targets

- Recraft
- Ideogram
- Adobe Firefly
- Kittl
- Canva
- Looka
- LogoAI
- Midjourney

## Results

### Recraft

Status: blocked for automation.

Notes:
- In-app browser remained logged out after signing in through the regular browser.
- Regular browser session is not exposed to the Codex browser automation backend.
- Next practical route: use Recraft manually in the regular browser, download results, then move the files into this run folder.

### Ideogram

Status: blocked before generation.

Notes:
- In-app browser showed the Ideogram sign-in dialog.
- No prompt was submitted.

### Adobe Firefly

Status: prompt filled, generation did not start in unauthenticated in-app session.

Captured files:
- `firefly-state.png`
- `firefly-after-click.png`

Notes:
- The prompt was entered successfully on the Firefly Text to image page.
- Clicking Generate did not start a job without a signed-in session.

### Kittl

Status: blocked by account creation gate.

Captured files:
- `kittl-after-click.png`

Notes:
- The prompt was entered successfully.
- Clicking Generate opened a Create Free Account dialog before generation.

### Canva

Status: blocked by login.

Captured files:
- `canva-login.png`

Notes:
- The public AI Logo Generator page redirects the actual Dream Lab generation flow to login.

### Looka

Status: not a same-prompt comparison target.

Notes:
- Looka uses a guided logo-maker flow based on company name, industry, styles, colors, and symbols.
- It is useful for brand-kit exploration, but it is not comparable to the same text-to-image prompt used for Recraft, Ideogram, Firefly, Kittl, and Canva Dream Lab.

### LogoAI

Status: not a same-prompt comparison target.

Notes:
- LogoAI is also a guided logo-maker flow rather than a direct prompt-to-image logo generator.
- It may be useful after choosing a product name, but it is not a fair same-prompt test.

### Midjourney

Status: not automated.

Notes:
- Midjourney should be run manually. Its guidelines prohibit unauthorized automation and third-party scripts.

## Manual Collection Path

Use the prompt in `prompt.md`.

For providers that require login in the regular browser:

1. Generate the logo using the same prompt.
2. Download the best 1-4 outputs as PNG/SVG where available.
3. Save or move them into this folder:
   `brand-research/logo-runs/2026-05-16-browser/`
4. Suggested filenames:
   - `recraft-01.png`
   - `ideogram-01.png`
   - `firefly-01.png`
   - `kittl-01.png`
   - `canva-01.png`
   - `midjourney-01.png`
