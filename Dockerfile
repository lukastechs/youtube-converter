FROM node:22-alpine

# Install system dependencies: ffmpeg, python3, py3-pip
RUN apk add --no-cache \
    ffmpeg \
    python3 \
    py3-pip

# Create and activate a Python virtual environment
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install yt-dlp in the virtual environment
RUN pip install yt-dlp \
    && yt-dlp --version

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
