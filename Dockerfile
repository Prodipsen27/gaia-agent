FROM node:20-slim

# Install Python and essential libraries for GAIA tools
RUN apt-get update && apt-get install -y python3 python3-pip && \
    pip3 install pdfplumber openpyxl pillow pandas duckduckgo-search beautifulsoup4 requests yt-dlp --break-system-packages && \
    apt-get clean

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
