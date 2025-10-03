FROM node:18-slim

# 1) Installer ffmpeg + fontconfig + polices DejaVu (drawtext + fonts)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg fontconfig fonts-dejavu-core && \
    rm -rf /var/lib/apt/lists/*

# 2) Dossier de travail
WORKDIR /app

# 3) Installer les dépendances de ton backend
COPY package*.json ./
RUN npm ci --omit=dev || npm i --omit=dev

# 4) Copier le code backend (index.js, public/, data/, etc.)
COPY . .

# 5) Variables d'environnement et port
ENV NODE_ENV=production
EXPOSE 8080

# 6) Démarrage (ton package.json contient "start": "node index.js")
CMD ["npm","start"]
