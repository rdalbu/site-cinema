# Cinema Drive-in

Streaming de vídeo ao vivo para RP de cidade. O vídeo fica no seu computador — nenhum arquivo é enviado ao servidor. Compartilhe o link com os espectadores e transmita em tempo real.

## Como funciona

1. Acesse o site → selecione o vídeo (ou arraste pra cima)
2. Copie o link da sala que aparece
3. Mande o link pro script de TV ou pros espectadores
4. O vídeo transmite direto do seu PC via WebSocket

## Funcionalidades

- Streaming ao vivo sem upload para o servidor
- Zero armazenamento — vídeo fica no PC do host
- Espectadores entram no ponto atual da transmissão
- Contagem de espectadores em tempo real
- Controles de pausar / retomar / encerrar
- Funciona com WebM (VP8/VP9) e MP4 (H.264)

## Rodando localmente

```bash
npm install
npm start
```

Acesse http://localhost:3000

## Deploy no Railway / Render

1. Push para o GitHub
2. Conecte o repositório no Railway ou Render
3. Detecta Node.js automaticamente — sem configuração extra

## Variáveis de ambiente

| Variável           | Padrão | Descrição                              |
|--------------------|--------|----------------------------------------|
| `PORT`             | 3000   | Porta do servidor                      |
| `MAX_BUFFER_CHUNKS`| 30     | Chunks mantidos em memória por sala    |

## Formato recomendado

Use **WebM (VP8/VP9 + Opus)** para compatibilidade máxima com MediaSource Extensions.
MP4 H.264 funciona no Chrome e Edge. Firefox tem suporte limitado a MP4 via MSE.
