# Cinema Drive-in

Site de streaming de vídeo temporário para RP de cidade. Faça upload de um vídeo, copie a URL direta e cole no script de TV. Sem cookies, sem login.

## Funcionalidades

- Upload por arrastar & soltar ou clique
- Streaming com Range headers (funciona em players de TV de RP)
- Copia URL direta para o clipboard
- Auto-delete após 24h
- Botão de exclusão manual

## Rodando localmente

```bash
npm install
npm start
```

Acesse http://localhost:3000

## Deploy no Railway

1. Fork ou clone este repositório no GitHub
2. No Railway: New Project → Deploy from GitHub repo → selecione este repo
3. Railway detecta Node.js automaticamente
4. (Opcional) Adicione a variável de ambiente `EXPIRE_HOURS` para mudar o tempo de expiração (padrão: 24)

## Variáveis de ambiente

| Variável       | Padrão | Descrição                   |
|----------------|--------|-----------------------------|
| `PORT`         | 3000   | Porta do servidor            |
| `EXPIRE_HOURS` | 24     | Horas até auto-delete        |

## Formato de vídeo

O player usa o elemento `<video>` nativo do browser. Formatos suportados: MP4 (H.264), WebM, Ogg. Para melhor compatibilidade com scripts de TV de RP, use **MP4 H.264**.
