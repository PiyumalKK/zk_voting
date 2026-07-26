# Conference Paper — Compilation & Figure Guide

## Compile the LaTeX

```bash
cd paper/
pdflatex main.tex
bibtex main        # if using .bib (currently inline \bibitem)
pdflatex main.tex
pdflatex main.tex  # run twice for references
```

Or use **Overleaf** (upload the `paper/` folder) for zero-setup compilation.

## Placeholder Figures — Drawing Guide

The paper has 4 placeholder figures. Replace them with professional diagrams (draw.io, Figma, or TikZ). Save as PDF/PNG in `figures/` and update `\includegraphics` in the LaTeX.

---

### Figure 1: System Architecture Diagram (`figures/architecture.pdf`)

**Layout:** Three horizontal layers, connected by arrows.

```
┌─────────────────────────────────────────────────────────────┐
│              BLOCKCHAIN LAYER                                 │
│  ┌──────────┐ ┌──────────────┐ ┌────────────────────┐       │
│  │Voting.sol│ │HonkVerifier  │ │ElectionRegistry.sol│       │
│  │(per div) │ │   .sol       │ │+ NicRegistry.sol   │       │
│  └──────────┘ └──────────────┘ └────────────────────┘       │
│  ┌─────────┐  ┌───────────┐                                 │
│  │ LeanIMT │  │PoseidonT3 │                                 │
│  └─────────┘  └───────────┘                                 │
└─────────────────────────────────────────────────────────────┘
        ↑ admin tx              ↑ register()      ↑ vote() [burner]
┌───────────────────┐    ┌─────────────────────────────────────┐
│   WEB APP         │    │        MOBILE APP                    │
│   (Next.js)       │    │        (React Native / Expo)         │
│                   │    │                                      │
│ • Admin Portal    │    │ • Hardware Keystore (key gen)        │
│ • GN Portal       │    │ • Biometric + PIN gate              │
│ • Results         │    │ • OTP verification                   │
│ • Observer Audit  │    │ • On-device ZK proof (bb.js WASM)   │
│ • API Routes      │    │ • Burner wallet (anonymous vote)    │
└───────────────────┘    └─────────────────────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │ CUSTOM GO BLOCKCHAIN │
                         │ (embedded EVM,       │
                         │  REST API, no gas)   │
                         └─────────────────────┘
```

**Colors:** Use blue for blockchain, green for web, purple for mobile, gray for Go chain.

---

### Figure 2: Phase State Machine (`figures/phases.pdf`)

```
 ┌───────┐  startRegistration(d)  ┌──────────────┐  startVoting(d)  ┌────────┐  endElection/timeout  ┌───────┐
 │ SETUP │ ─────────────────────→ │ REGISTRATION │ ────────────────→ │ VOTING │ ───────────────────→  │ ENDED │
 └───────┘                        └──────────────┘                   └────────┘                       └───────┘
    │                                   │                                │                               │
 Set question                     Voters submit                     Voters cast                      Results
 Set candidates                   commitments                       ZK proofs                        finalized
 Allowlist voters                 (register())                      (vote())
 Assign GN
```

**Style:** Rounded rectangles for states, arrows with labels, small text below each state.

---

### Figure 3: Three-Gate Authentication (`figures/threegate.pdf`)

```
┌─────────────────────────────────────────┐
│            VOTER'S PHONE                 │
│                                          │
│  ┌─────────────────────────────────┐    │
│  │ GATE 1: OTP (SMS code)          │    │
│  │ → proves: phone is present      │    │
│  │ → prevents: delegation          │    │
│  └────────────────┬────────────────┘    │
│                   ▼                      │
│  ┌─────────────────────────────────┐    │
│  │ GATE 2: BIOMETRIC               │    │
│  │ → proves: body is present       │    │
│  │ → prevents: theft               │    │
│  └────────────────┬────────────────┘    │
│                   ▼                      │
│  ┌─────────────────────────────────┐    │
│  │ GATE 3: PIN/PASSCODE            │    │
│  │ → proves: knowledge             │    │
│  │ → prevents: coercion            │    │
│  └────────────────┬────────────────┘    │
│                   ▼                      │
│  ┌─────────────────────────────────┐    │
│  │ HARDWARE KEYSTORE UNLOCKED      │    │
│  │ → private key released          │    │
│  │ → generate ZK proof             │    │
│  │ → cast vote via burner wallet   │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

**Style:** Vertical flow, green badges for each gate, red "prevents" labels.

---

### Figure 4: Multi-Division Hierarchy (`figures/divisions.pdf`)

```
                    ┌──────────────────────┐
                    │  Election Registry   │
                    │  (national level)    │
                    └──────────┬───────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                  │
   ┌────────▼────────┐ ┌──────▼───────┐ ┌───────▼───────┐
   │ Kaduwela         │ │ Colombo      │ │ Gampaha       │
   │ Voting.sol       │ │ Voting.sol   │ │ Voting.sol    │
   │ GN: 0x7099...    │ │ GN: 0x3C44..│ │ GN: 0x90F7... │
   │ Voters: 12,450   │ │ Voters: 8,200│ │ Voters: 15,100│
   └─────────────────┘ └──────────────┘ └───────────────┘
            │                  │                  │
            └──────────────────┼──────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │ National Aggregation  │
                    │ getNationalResults()  │
                    └──────────────────────┘
```

**Style:** Tree structure, dashed lines for aggregation, each division box shows key metadata.

---

## Tips for Award-Winning Papers

1. **Strong abstract** — state the problem, approach, key result, and significance in ≤200 words
2. **Clear contribution list** — numbered, specific, verifiable claims
3. **Comparison table** — show how your system beats MACI, Semaphore, Voatz on specific dimensions
4. **Honest limitations** — acknowledge ballot secrecy gap, proof speed, trusted setup
5. **Reproducibility** — mention open-source code and test results
6. **Professional figures** — use consistent colors, clean typography, no screenshots
