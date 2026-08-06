# Quick Start Guide: Custom Blockchain Mode

Me guide eka pawichchi karala oya ge project eka custom blockchain eka (no-wallet auth) ekka run karanna puluwan. 
Terminal 3k (tab 3k) open karagena me commands tika piliwelata run karanna.

> **Note:** `.env.local` eke thiyena secrets (Session secret, Admin password hash, etc.) mama kalinma setup karala thiyenne. E hinda ewa gena wada wenna oni na! Admin login wenne `admin` username ekai `admin123` password ekai dala.

---

## 1. Start the Custom Blockchain Node (Terminal 1)

Mulinma custom blockchain node eka start karaganna oni.

```bash
cd packages/blockchain

# Palamuweni parata run karaddi witharai meka oni:
go mod download

# Node eka start karanna
make run
```

**Reset karanna oni unoth:** Kalin data makala aluthenma patan ganna oni nam `make reset` run karanna.

---

## 2. Deploy Smart Contracts (Terminal 2)

Node eka run wena athare, thawa terminal ekak open karala contracts tika custom chain ekata deploy karanna oni.
Root folder (zk_voting 2) eke idan me commands run karanna.

```bash
# Palamuweni parata witharai
yarn install

# Custom chain ekata contracts deploy karanna
yarn deploy --network custom --reset
```

---

## 3. Start the Next.js Frontend (Terminal 3)

Dan node ekath wada, contracts deploy karalath iwarai. Anthimata frontend app eka start karanna.
Root folder eke idan me command eka run karanna.

```bash
yarn start
```

Eeta passe browser eke `http://localhost:3000` ekata yanna!

---

## 4. Start the Mobile App (Terminal 4)

Oyata mobile app eka run karanna oni nam, thawa terminal ekak (4 weni eka) open karagena meka run karanna.

```bash
cd packages/mobile

# Palamuweni parata witharai
yarn install

# Expo bundler eka start karanna
yarn start
```

Eeta passe oyage phone eke **Expo Go** app eka (Play Store/App Store eken) download karala, terminal eke ena QR code eka scan karanna!
