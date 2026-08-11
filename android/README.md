# Bússola Finance — Android

Esta pasta é reservada para o projeto nativo Android (TWA — Trusted Web
Activity), que empacota a PWA (pasta raiz do repositório) para publicação
na Google Play Store.

Nada aqui ainda — o app web na raiz do repositório continua sendo a fonte
única de verdade para o conteúdo/funcionalidade. Esta pasta vai receber o
projeto gerado por ferramentas como o [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap)
ou o [PWABuilder](https://www.pwabuilder.com/), incluindo:

- Projeto Android Studio / Gradle do wrapper TWA
- `assetlinks.json` (Digital Asset Links, para verificar o domínio)
- Ícones e splash screens específicos do Android
- Configuração de assinatura do APK/AAB

## Não confundir com a web

O app web (`index.html`, `manifest.json`, `sw.js`, ícones) mora na raiz
deste repositório e é publicado direto na Netlify — essa pasta `android/`
não interfere nesse deploy.
