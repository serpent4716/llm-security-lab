#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Run this ONCE on the EC2 server after SSHing in
# Sets up Docker, Jenkins, clones repo, starts everything
# Usage: bash setup-ec2.sh YOUR_GITHUB_USERNAME YOUR_GITHUB_TOKEN
# ─────────────────────────────────────────────────────────────

GITHUB_USER=$1
GITHUB_TOKEN=$2

if [ -z "$GITHUB_USER" ] || [ -z "$GITHUB_TOKEN" ]; then
  echo "Usage: bash setup-ec2.sh YOUR_GITHUB_USERNAME YOUR_GITHUB_TOKEN"
  exit 1
fi

set -e
echo "======================================"
echo " Step 1: Installing Docker"
echo "======================================"
sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose git python3-pip curl net-tools
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker ubuntu
sudo usermod -aG docker $USER

echo "======================================"
echo " Step 2: Installing Java 21 + Jenkins"
echo "======================================"
sudo apt-get install -y openjdk-21-jdk

# Download Jenkins war directly (avoids apt repo issues)
sudo mkdir -p /usr/share/jenkins /var/lib/jenkins /var/log/jenkins
sudo wget -q -O /usr/share/jenkins/jenkins.war \
  https://get.jenkins.io/war-stable/latest/jenkins.war
echo "Jenkins downloaded"

# Create jenkins user
sudo useradd -m -d /var/lib/jenkins -s /bin/bash jenkins 2>/dev/null || true
sudo chown -R jenkins:jenkins /var/lib/jenkins /var/log/jenkins /usr/share/jenkins

# Add jenkins to docker group
sudo usermod -aG docker jenkins

echo "======================================"
echo " Step 3: Cloning repo"
echo "======================================"
cd /home/ubuntu
git clone https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/llm-security-lab.git
cd llm-security-lab

echo "======================================"
echo " Step 4: Fixing docker-compose.yml"
echo "======================================"
# Download the clean AWS version
cat > docker-compose.yml << 'COMPOSEFILE'
services:

  postgres:
    image: postgres:16-alpine
    container_name: llm-lab-postgres
    restart: unless-stopped
    volumes:
      - postgres_data:/var/lib/postgresql/data/pgdata
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    environment:
      POSTGRES_DB:       ctf_lab
      POSTGRES_USER:     ctf_user
      POSTGRES_PASSWORD: ctf_local_pass_2024
      PGDATA:            /var/lib/postgresql/data/pgdata
    networks: [llm-lab-net]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ctf_user -d ctf_lab"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  ollama:
    image: ollama/ollama:latest
    container_name: llm-lab-ollama
    restart: unless-stopped
    volumes:
      - ollama_models:/root/.ollama
    environment:
      - OLLAMA_NUM_PARALLEL=1
      - OLLAMA_MAX_LOADED_MODELS=1
      - OLLAMA_KEEP_ALIVE=5m
    networks: [llm-lab-net]

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    image: llm-lab-backend:local
    container_name: llm-lab-backend
    restart: unless-stopped
    volumes:
      - ./backend/levels.json:/app/config/levels.json:ro
      - ./backend/eval_service.py:/app/eval_service.py:ro
    environment:
      DATABASE_URL:      postgresql://ctf_user:ctf_local_pass_2024@postgres:5432/ctf_lab
      OLLAMA_BASE_URL:   http://ollama:11434
      OLLAMA_MODEL:      llama3.2:1b
      CTF_LEVELS_PATH:   /app/config/levels.json
      CORS_ORIGINS:      "*"
      SECRET_KEY:        aws-demo-secret-key
      LLM_TIMEOUT_SECS:  180
      LLM_MAX_TOKENS:    350
      LLM_TEMPERATURE:   0.7
      RATE_LIMIT_ATTEMPTS: 50
      RELOAD:            "false"
    ports:
      - "127.0.0.1:8000:8000"
    networks: [llm-lab-net]
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8000/health"]
      interval: 20s
      timeout: 10s
      retries: 5
      start_period: 30s

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile.dev
    image: llm-lab-frontend:local
    container_name: llm-lab-frontend
    restart: unless-stopped
    volumes:
      - ./frontend/src:/app/src:ro
      - ./frontend/public:/app/public:ro
    environment:
      NEXT_PUBLIC_BACKEND_URL: ""
      NODE_ENV: development
    networks: [llm-lab-net]
    depends_on:
      - backend
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3000"]
      interval: 30s
      timeout: 15s
      retries: 3
      start_period: 90s

  nginx:
    image: nginx:alpine
    container_name: llm-lab-nginx
    restart: unless-stopped
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "0.0.0.0:80:80"
    networks: [llm-lab-net]
    depends_on:
      - frontend
      - backend

volumes:
  ollama_models:
  postgres_data:

networks:
  llm-lab-net:
    driver: bridge
COMPOSEFILE

echo "======================================"
echo " Step 5: Fixing nginx.conf"
echo "======================================"
sed -i 's/\$remote_method/\$request_method/g' nginx/nginx.conf

echo "======================================"
echo " Step 6: Building and starting app"
echo "======================================"
# Apply docker group without re-login
newgrp docker << 'DOCKERCMDS'
cd /home/ubuntu/llm-security-lab
docker-compose build backend frontend
docker-compose up -d postgres ollama
echo "Waiting for postgres to be ready..."
sleep 15
docker-compose up -d
DOCKERCMDS

echo "======================================"
echo " Step 7: Pulling AI model"
echo "======================================"
echo "Waiting 20s for ollama to start..."
sleep 20
docker exec llm-lab-ollama ollama pull llama3.2:1b

echo "======================================"
echo " Step 8: Starting Jenkins"
echo "======================================"
sudo -u jenkins java -jar /usr/share/jenkins/jenkins.war \
  --httpPort=8080 \
  --logfile=/var/log/jenkins/jenkins.log \
  --daemon

echo "Waiting 40s for Jenkins to start..."
sleep 40

echo "======================================"
echo " ALL DONE!"
echo "======================================"
SERVER_IP=$(curl -s ifconfig.me)
echo ""
echo "✅ App URL:     http://${SERVER_IP}"
echo "✅ Jenkins URL: http://${SERVER_IP}:8080"
echo ""
echo "Jenkins initial password:"
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
echo ""
docker-compose ps
