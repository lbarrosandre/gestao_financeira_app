# Bússola Finance — iOS

Esta pasta é reservada para o trabalho específico de iOS.

Decisão atual (ver histórico de conversa do projeto): por enquanto o app
no iPhone é a própria PWA (pasta raiz do repositório), instalada via
Safari → Compartilhar → "Adicionar à Tela de Início". Não há projeto
nativo Xcode/App Store neste momento — isso exigiria:

- Mac com Xcode (build/assinatura do app nativo)
- Conta Apple Developer Program (US$99/ano)
- Passar pela revisão da App Store

Se/quando decidirmos publicar de verdade na App Store, o projeto nativo
(provavelmente gerado via [PWABuilder](https://www.pwabuilder.com/) ou
Capacitor, apontando pro app web) entra aqui.

## Não confundir com a web

O app web (`index.html`, `manifest.json`, `sw.js`, ícones) mora na raiz
deste repositório e é publicado direto na Netlify — essa pasta `ios/`
não interfere nesse deploy. Ajustes de compatibilidade com Safari/iOS
(ex: meta tags `apple-*`, ícone da tela inicial) continuam sendo feitos
direto nos arquivos da raiz, já que fazem parte da PWA.
