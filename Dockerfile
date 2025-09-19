FROM node:22-alpine

# Install system dependencies: ffmpeg, curl, python3, build tools
RUN apk add --no-cache \
    ffmpeg \
    curl \
    python3 \
    py3-pip \
    build-base

# Download and install yt-dlp standalone binary
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Set working directory
WORKDIR /app

# Copy package.json and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the code
COPY . .

# Expose the port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
