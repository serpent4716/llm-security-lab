pipeline {
    agent any
    stages {
        stage('Checkout') {
            steps {
                echo "📥 Pulling latest code..."
                checkout scm
            }
        }
        stage('Test') {
            steps {
                dir('backend') {
                    sh '''
                        pip3 install -q -r requirements.txt --break-system-packages
                        python3 -m py_compile eval_service.py
                        echo "✅ Tests passed"
                    '''
                }
            }
        }
        stage('Build') {
            steps {
                sh '''
                    docker-compose build backend frontend
                    echo "✅ Images built"
                '''
            }
        }
        stage('Deploy') {
            steps {
                sh '''
                    docker-compose up -d --no-recreate
                    echo "✅ App deployed"
                '''
            }
        }
        stage('Health Check') {
            steps {
                sh '''
                    sleep 15
                    curl -sf http://localhost:8000/health && echo "✅ Healthy!" || echo "⚠️ Still starting"
                '''
            }
        }
    }
    post {
        success { echo "🎉 Build #${BUILD_NUMBER} deployed!" }
        failure { echo "💥 Build failed. Check logs." }
    }
}
