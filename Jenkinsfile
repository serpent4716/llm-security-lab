pipeline {
    agent any

    stages {

        stage('Checkout') {
            steps {
                echo "📥 Pulling latest code from GitHub..."
                checkout scm
            }
        }

        stage('Test') {
            steps {
                echo "🧪 Running backend tests..."
                dir('backend') {
                    sh '''
                        pip3 install -q -r requirements.txt
                        python3 -m py_compile eval_service.py
                        echo "✅ All tests passed"
                    '''
                }
            }
        }

        stage('Build') {
            steps {
                echo "🐳 Building Docker images..."
                sh '''
                    docker compose build backend frontend
                    echo "✅ Images built"
                '''
            }
        }

        stage('Deploy') {
            steps {
                echo "🚀 Deploying application..."
                sh '''
                    docker compose up -d
                    echo "✅ App is live"
                '''
            }
        }

        stage('Health Check') {
            steps {
                echo "🏥 Verifying deployment..."
                sh '''
                    sleep 15
                    curl -sf http://localhost:8000/health \
                        && echo "✅ Backend healthy" \
                        || echo "⚠️ Backend still starting"
                '''
            }
        }
    }

    post {
        success {
            echo "🎉 Pipeline complete!"
        }
        failure {
            echo "💥 Pipeline failed. Check logs."
        }
    }
}
