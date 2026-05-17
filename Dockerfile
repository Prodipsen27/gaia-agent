FROM node:20-slim

# Install Python, ffmpeg, and all Python packages needed by GAIA tools
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    pip3 install --break-system-packages \
      yt-dlp pdfplumber openpyxl pillow pandas requests \
      beautifulsoup4 duckduckgo-search && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files first for better caching
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Ensure the temporary directory exists for downloads and transcripts
RUN mkdir -p tmp

# Standard port for HF Spaces
EXPOSE 7860

# Start the orchestrator
CMD ["node", "src/index.js"]
