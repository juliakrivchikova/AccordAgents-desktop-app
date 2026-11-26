import base64, json, re, sys
root = sys.argv[1]
src = open('side-panel.src.html').read()
tpl = open(f'{root}/docs/design/ui-refresh/mockups/new-chat.html').read()
fonts = re.findall(r'src: url\((data:font/woff2;base64,[^)]+)\)', tpl)
assert len(fonts) == 2
icons = json.load(open('icons.json'))
def png(name):
    return 'data:image/png;base64,' + base64.b64encode(open(f'{root}/docs/design/ui-refresh/mockups/assets/{name}', 'rb').read()).decode()
def ph(name):
    return f'<span class="ph"><svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" fill="currentColor" viewBox="0 0 256 256" aria-hidden="true">{icons[name]}</svg></span>'
out = src.replace('%%FONT_LATIN%%', fonts[0]).replace('%%FONT_CYR%%', fonts[1])
out = out.replace('%%IMG_AG%%', '"' + png('antigravity-logo.png') + '"').replace('%%IMG_CLAUDE%%', '"' + png('claude-mark.png') + '"')
out = re.sub(r'%%ICON:(\w+)%%', lambda m: ph(m.group(1)), out)
out = out.replace('%%ICONS%%', json.dumps(icons))
assert '%%' not in out, re.findall(r'%%\w+%%', out)
import os
os.makedirs(f'{root}/docs/design/side-panel', exist_ok=True)
open(f'{root}/docs/design/side-panel/side-panel.html', 'w').write(out)
print(len(out))
