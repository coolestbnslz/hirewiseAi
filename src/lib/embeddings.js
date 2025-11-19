/**
 * Embeddings service using Amazon Bedrock Titan Embeddings (REST API with Bearer token)
 * Used for semantic tag matching and similarity calculations
 */

import dotenv from 'dotenv';

dotenv.config();

// AWS Bedrock configuration
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const AWS_BEARER_TOKEN_BEDROCK = process.env.AWS_BEARER_TOKEN_BEDROCK;
const BEDROCK_ENDPOINT = `https://bedrock-runtime.${AWS_REGION}.amazonaws.com`;

// Titan Embeddings model ID
const EMBEDDING_MODEL_ID = process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v1';

// Cache for tag embeddings (to avoid regenerating them every time)
const tagEmbeddingsCache = new Map();

/**
 * Common tech stack tags for matching
 * This can be expanded or loaded from a database
 * Includes common variations and aliases (e.g., golang, Go)
 */
const COMMON_TAGS = [
  // Programming Languages
  'JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Golang', 'Rust', 'Ruby', 'PHP', 
  'Swift', 'Kotlin', 'Scala', 'R', 'MATLAB', 'Perl', 'Lua', 'Dart', 'Elixir', 'Erlang', 'Haskell',
  'Clojure', 'F#', 'Objective-C', 'Assembly', 'Shell Scripting', 'Bash', 'PowerShell',
  
  // Frontend Frameworks & Libraries
  'React', 'Vue.js', 'Vue', 'Angular', 'AngularJS', 'Next.js', 'Nuxt.js', 'Svelte', 'Ember.js',
  'HTML', 'HTML5', 'CSS', 'CSS3', 'SASS', 'SCSS', 'Less', 'Tailwind CSS', 'Bootstrap', 'Material-UI',
  'Webpack', 'Vite', 'Parcel', 'Rollup', 'Babel', 'ESLint', 'Prettier', 'Jest', 'Cypress',
  'Redux', 'MobX', 'Zustand', 'Apollo Client', 'React Query',
  
  // Backend Frameworks & Technologies
  'Node.js', 'Node', 'Express', 'Express.js', 'NestJS', 'Fastify', 'Koa', 'Hapi', 'Sails.js',
  'Django', 'Flask', 'FastAPI', 'Tornado', 'Bottle', 'CherryPy', 'Pyramid',
  'Spring Boot', 'Spring', 'Spring MVC', 'Spring Cloud', 'Hibernate', 'JPA',
  'ASP.NET', '.NET', 'ASP.NET Core', 'Entity Framework', 'WCF', 'WPF',
  'Ruby on Rails', 'Rails', 'Sinatra', 'Grape',
  'Laravel', 'Symfony', 'CodeIgniter', 'Zend Framework',
  'Phoenix', 'Plug', 'Cowboy',
  
  // Databases
  'MongoDB', 'PostgreSQL', 'Postgres', 'MySQL', 'MariaDB', 'SQLite', 'Oracle', 'SQL Server',
  'Redis', 'Memcached', 'DynamoDB', 'Elasticsearch', 'Cassandra', 'CouchDB', 'Neo4j',
  'InfluxDB', 'TimescaleDB', 'CockroachDB', 'Firebase', 'Firestore', 'Supabase',
  'Prisma', 'Sequelize', 'TypeORM', 'Mongoose', 'SQLAlchemy',
  
  // Cloud & DevOps
  'AWS', 'Amazon Web Services', 'EC2', 'S3', 'Lambda', 'API Gateway', 'CloudFormation',
  'Azure', 'Microsoft Azure', 'Azure Functions', 'Azure DevOps',
  'GCP', 'Google Cloud Platform', 'Cloud Functions', 'App Engine', 'Cloud Run',
  'Docker', 'Kubernetes', 'K8s', 'Helm', 'Terraform', 'Ansible', 'Puppet', 'Chef',
  'CI/CD', 'Jenkins', 'GitLab CI', 'GitHub Actions', 'CircleCI', 'Travis CI', 'Bamboo',
  'Prometheus', 'Grafana', 'ELK Stack', 'Splunk', 'Datadog', 'New Relic',
  
  // Mobile Development
  'React Native', 'Flutter', 'Ionic', 'Xamarin', 'Cordova', 'PhoneGap',
  'iOS', 'Android', 'Swift', 'Kotlin', 'Objective-C', 'Xcode', 'Android Studio',
  
  // Data & AI/ML
  'Machine Learning', 'ML', 'Deep Learning', 'AI', 'Artificial Intelligence',
  'TensorFlow', 'PyTorch', 'Keras', 'Scikit-learn', 'Pandas', 'NumPy', 'Matplotlib',
  'Data Science', 'Big Data', 'Apache Spark', 'Hadoop', 'Hive', 'Pig', 'Kafka',
  'Jupyter', 'Notebook', 'R Studio', 'Tableau', 'Power BI',
  
  // Testing & QA
  'Jest', 'Mocha', 'Chai', 'Jasmine', 'Cypress', 'Selenium', 'Playwright', 'Puppeteer',
  'Unit Testing', 'Integration Testing', 'E2E Testing', 'TDD', 'BDD',
  
  // APIs & Protocols
  'REST API', 'REST', 'GraphQL', 'gRPC', 'WebSocket', 'SOAP', 'RPC',
  'OAuth', 'JWT', 'OpenID Connect', 'API Gateway',
  
  // Architecture & Patterns
  'Microservices', 'Serverless', 'Event-Driven', 'Domain-Driven Design', 'DDD',
  'MVC', 'MVP', 'MVVM', 'Clean Architecture', 'Hexagonal Architecture',
  
  // Methodologies & Practices
  'Agile', 'Scrum', 'Kanban', 'DevOps', 'SRE', 'Site Reliability Engineering',
  'TDD', 'BDD', 'Continuous Integration', 'Continuous Deployment',
  
  // General Roles & Skills
  'Software Engineer', 'Full Stack Developer', 'Full Stack', 'Backend Developer', 'Backend',
  'Frontend Developer', 'Frontend', 'DevOps Engineer', 'DevOps', 'SRE Engineer',
  'Data Engineer', 'Data Scientist', 'ML Engineer', 'AI Engineer',
  'Mobile Developer', 'iOS Developer', 'Android Developer',
  'QA Engineer', 'Test Engineer', 'QA Automation', 'Security Engineer',
  'Cloud Engineer', 'Solutions Architect', 'Tech Lead', 'Engineering Manager',
  
  // Additional Technologies
  'Git', 'GitHub', 'GitLab', 'Bitbucket', 'SVN', 'Mercurial',
  'Linux', 'Unix', 'Windows Server', 'macOS',
  'Nginx', 'Apache', 'HAProxy', 'Load Balancing',
  'RabbitMQ', 'Apache Kafka', 'ActiveMQ', 'SQS', 'SNS',
  'Blockchain', 'Ethereum', 'Solidity', 'Web3', 'Smart Contracts',
  'Game Development', 'Unity', 'Unreal Engine', 'Cocos2d',
];

/**
 * Generate embedding for a text using Amazon Bedrock Titan Embeddings REST API
 * Uses Bearer token authentication (same as Converse API)
 */
export async function generateEmbedding(text) {
  try {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Text must be a non-empty string');
    }

    // Validate credentials
    if (!AWS_BEARER_TOKEN_BEDROCK) {
      throw new Error('AWS Bearer token not configured. Please set AWS_BEARER_TOKEN_BEDROCK in your .env file.');
    }

    // Titan Embeddings API expects inputText as an array
    const body = {
      inputText: [text],
    };

    // Prepare request URL (embeddings use /invoke endpoint, not /converse)
    const url = `${BEDROCK_ENDPOINT}/model/${EMBEDDING_MODEL_ID}/invoke`;

    // Make the HTTP request with Bearer token
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AWS_BEARER_TOKEN_BEDROCK}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { message: errorText };
      }

      if (response.status === 403) {
        throw new Error('Access denied to Bedrock. Please ensure your Bearer token has Bedrock permissions and model access is enabled.');
      }
      if (response.status === 400) {
        throw new Error(`Invalid Bedrock model ID: ${EMBEDDING_MODEL_ID}. Please check BEDROCK_EMBEDDING_MODEL_ID in your .env file. ${errorData.message || ''}`);
      }
      if (response.status === 401) {
        throw new Error('AWS Bearer token invalid. Please check AWS_BEARER_TOKEN_BEDROCK in your .env file.');
      }

      throw new Error(`Bedrock API error (${response.status}): ${errorData.message || errorText}`);
    }

    const responseBody = await response.json();

    // Titan embeddings returns embedding in the response
    // Format: { "embedding": [[0.1, 0.2, ...]] } (array of arrays, one per input text)
    // Since we send one text, we get one embedding array
    const embedding = responseBody.embedding?.[0] || responseBody.embeddingVector || responseBody.embeddings?.[0];
    
    if (!embedding || !Array.isArray(embedding)) {
      console.error('[Embeddings] Unexpected response format:', responseBody);
      throw new Error(`Invalid embedding response format. Expected array, got: ${typeof embedding}`);
    }

    return embedding;
  } catch (error) {
    console.error('[Embeddings] Error generating embedding:', error);
    throw new Error(`Failed to generate embedding: ${error.message}`);
  }
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(embedding1, embedding2) {
  if (embedding1.length !== embedding2.length) {
    throw new Error('Embeddings must have the same dimension');
  }

  let dotProduct = 0;
  let norm1 = 0;
  let norm2 = 0;

  for (let i = 0; i < embedding1.length; i++) {
    dotProduct += embedding1[i] * embedding2[i];
    norm1 += embedding1[i] * embedding1[i];
    norm2 += embedding2[i] * embedding2[i];
  }

  const denominator = Math.sqrt(norm1) * Math.sqrt(norm2);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Find relevant tags using embeddings
 * @param {string} text - Job description or resume text
 * @param {number} topK - Number of top tags to return (default: 10)
 * @param {number} minSimilarity - Minimum similarity threshold (default: 0.3)
 * @returns {Promise<Array<{tag: string, similarity: number}>>}
 */
export async function findTagsUsingEmbeddings(text, topK = 10, minSimilarity = 0.3) {
  try {
    // Generate embedding for the input text
    const textEmbedding = await generateEmbedding(text);

    // Generate embeddings for all common tags (use cache if available)
    const tagEmbeddings = [];
    
    // Check cache first, generate if not cached
    for (const tag of COMMON_TAGS) {
      let embedding;
      
      if (tagEmbeddingsCache.has(tag)) {
        embedding = tagEmbeddingsCache.get(tag);
      } else {
        try {
          embedding = await generateEmbedding(tag);
          tagEmbeddingsCache.set(tag, embedding); // Cache for future use
        } catch (error) {
          console.error(`[Embeddings] Error generating embedding for tag "${tag}":`, error);
          continue; // Skip this tag if embedding fails
        }
      }
      
      tagEmbeddings.push({ tag, embedding });
    }

    // Calculate similarity scores
    const similarities = tagEmbeddings
      .map(({ tag, embedding }) => ({
        tag,
        similarity: cosineSimilarity(textEmbedding, embedding),
      }))
      .filter(item => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    return similarities;
  } catch (error) {
    console.error('[Embeddings] Error finding tags:', error);
    throw error;
  }
}

/**
 * Normalize tag name (handles common variations)
 * e.g., "golang" -> "Go", "node" -> "Node.js"
 */
function normalizeTagName(tag) {
  const tagLower = tag.toLowerCase().trim();
  
  // Common aliases and variations
  const aliases = {
    'golang': 'Go',
    'node': 'Node.js',
    'nodejs': 'Node.js',
    'postgres': 'PostgreSQL',
    'postgresql': 'PostgreSQL',
    'vue': 'Vue.js',
    'vuejs': 'Vue.js',
    'angularjs': 'Angular',
    'reactjs': 'React',
    'nextjs': 'Next.js',
    'nuxtjs': 'Nuxt.js',
    'expressjs': 'Express',
    'express.js': 'Express',
    'rails': 'Ruby on Rails',
    'ror': 'Ruby on Rails',
    'aspnet': 'ASP.NET',
    'dotnet': '.NET',
    'k8s': 'Kubernetes',
    'ml': 'Machine Learning',
    'ai': 'Artificial Intelligence',
    'aws': 'AWS',
    'gcp': 'GCP',
    'azure': 'Azure',
  };

  return aliases[tagLower] || tag;
}

/**
 * Extract tags from job description using embeddings
 * Combines embeddings-based matching with explicit skills from job
 */
export async function extractTagsFromJob(job) {
  try {
    // Combine job description text
    const jobText = [
      job.raw_jd || '',
      job.role || '',
      job.seniority || '',
      ...(job.must_have_skills || []),
      ...(job.nice_to_have || []),
    ].filter(Boolean).join(' ');

    // Find tags using embeddings
    const embeddingTags = await findTagsUsingEmbeddings(jobText, 20, 0.25);

    // Extract and normalize tag names
    let tags = embeddingTags.map(item => normalizeTagName(item.tag));

    // Add explicit skills if not already included (normalize them too)
    const allSkills = [
      ...(job.must_have_skills || []),
      ...(job.nice_to_have || []),
    ];

    allSkills.forEach(skill => {
      const normalizedSkill = normalizeTagName(skill.trim());
      if (normalizedSkill && !tags.some(t => t.toLowerCase() === normalizedSkill.toLowerCase())) {
        tags.push(normalizedSkill);
      }
    });

    // Add role and seniority if not already included
    if (job.role) {
      const normalizedRole = normalizeTagName(job.role);
      if (!tags.some(t => t.toLowerCase().includes(normalizedRole.toLowerCase()))) {
        tags.push(normalizedRole);
      }
    }

    // Remove duplicates (case-insensitive)
    const uniqueTags = [];
    const seen = new Set();
    for (const tag of tags) {
      const lower = tag.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        uniqueTags.push(tag);
      }
    }

    // Limit to top 25 tags
    return uniqueTags.slice(0, 25);
  } catch (error) {
    console.error('[Embeddings] Error extracting tags from job:', error);
    // Fallback to basic tags
    return [
      job.role,
      ...(job.must_have_skills || []),
      ...(job.nice_to_have || []),
    ].filter(Boolean).map(t => normalizeTagName(t));
  }
}

/**
 * Extract tags from resume text using embeddings
 */
export async function extractTagsFromResume(resumeText) {
  try {
    if (!resumeText || resumeText.trim().length === 0) {
      return [];
    }

    const embeddingTags = await findTagsUsingEmbeddings(resumeText, 20, 0.25);
    
    // Normalize tag names and remove duplicates
    const tags = embeddingTags.map(item => normalizeTagName(item.tag));
    const uniqueTags = [];
    const seen = new Set();
    for (const tag of tags) {
      const lower = tag.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        uniqueTags.push(tag);
      }
    }
    
    return uniqueTags;
  } catch (error) {
    console.error('[Embeddings] Error extracting tags from resume:', error);
    return [];
  }
}

