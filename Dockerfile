FROM node:20-slim

# Install Python and essential libraries for GAIA tools
RUN apt-get update && apt-get install -y python3 python3-pip && \
    pip3 install pdfplumber openpyxl pillow pandas duckduckgo-search beautifulsoup4 requests yt-dlp --break-system-packages && \
    apt-get clean

# Create a non-root user for HF Spaces (UID 1000)
RUN useradd -m -u 1000 user
WORKDIR /app

# Copy dependency files first for better caching
COPY --chown=user package*.json ./
RUN npm install

# Copy the rest of the application
COPY --chown=user . .

# Ensure the temporary directory exists and is writable by the 'user'
RUN mkdir -p /app/tmp && chown -R user:user /app/tmp

USER user
ENV PATH="/home/user/.local/bin:$PATH"

# Standard port for HF Spaces
EXPOSE 7860

# Start the orchestrator
CMD ["node", "src/index.js"]
