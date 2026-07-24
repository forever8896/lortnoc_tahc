# Brand fonts

Repo-safe stand-ins for **Qurova** (whose demo is personal-use-only and must not ship here).
Both are **SIL Open Font License 1.1** — free for commercial use and redistribution.

| Role | Family | Weights | Source |
|---|---|---|---|
| **Wordmark** | Questrial | 400 | [github.com/googlefonts/questrial](https://github.com/googlefonts/questrial) |
| **Text / UI** | Jost | 300–700 | [github.com/indestructible-type/Jost](https://github.com/indestructible-type/Jost) |

## Use

```css
@import url("assets/fonts/fonts.css");

.wordmark { font-family: var(--font-wordmark); } /* Questrial */
body      { font-family: var(--font-body); }     /* Jost */
```

License texts live beside each family in `OFL.txt`. If **Qurova** is later licensed for
production, swap the families here and the rest of the app is unchanged.
