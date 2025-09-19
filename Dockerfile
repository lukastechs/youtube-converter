here's my docker FROM node:22-alpine

# Install system dependencies (ffmpeg via apk, curl for yt-dlp)
RUN apk add --no-cache ffmpeg curl

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

# Expose the port (optional, Render handles it)
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
