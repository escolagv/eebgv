# APOIA Professor (Mobile Wrapper)

Este projeto gera um app Android/iOS que abre o ambiente do professor:
`https://eebgv.vercel.app/apoia/professor.html`

## Pré-requisitos
- Node.js 18+ instalado
- Android Studio + Android SDK (para APK)
- macOS + Xcode (para iOS/IPA)

## Instalação
```powershell
cd appprof-mobile
npm install
npx cap add android
```

## Android (APK)
```powershell
npx cap sync android
npx cap open android
```
No Android Studio, gere o APK em `Build > Build Bundle(s) / APK(s) > Build APK(s)`.

## iOS
```powershell
npx cap add ios
npx cap sync ios
npx cap open ios
```
Use o Xcode para assinar e gerar o `.ipa` (precisa macOS).

## Observações
- O app é um wrapper do site. Se quiser embarcar o conteúdo offline, remova `server.url` no `capacitor.config.json` e copie o web build para `www/`.
