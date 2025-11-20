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

    // Titan Embeddings API expects inputText as a string (not an array)
    const body = {
      inputText: text,
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
    // Format: { "embedding": [0.1, 0.2, ...] } (single array for single input text)
    // Since we send one text as a string, we get one embedding array directly
    const embedding = responseBody.embedding || responseBody.embeddingVector || responseBody.embeddings?.[0];
    
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
    console.log('[Embeddings] Generating embedding for input text...');
    const textEmbedding = await generateEmbedding(text);
    console.log('[Embeddings] Input text embedding generated');

    // Generate embeddings for all common tags (use cache if available)
    const tagEmbeddings = [];
    const totalTags = COMMON_TAGS.length;
    let cachedCount = 0;
    let generatedCount = 0;
    
    console.log(`[Embeddings] Processing ${totalTags} tags (checking cache first)...`);
    
    // Check cache first, generate if not cached
    for (let i = 0; i < COMMON_TAGS.length; i++) {
      const tag = COMMON_TAGS[i];
      let embedding;
      
      if (tagEmbeddingsCache.has(tag)) {
        embedding = tagEmbeddingsCache.get(tag);
        cachedCount++;
        if ((i + 1) % 50 === 0) {
          console.log(`[Embeddings] Progress: ${i + 1}/${totalTags} tags processed (${cachedCount} cached, ${generatedCount} generated)`);
        }
      } else {
        try {
          embedding = await generateEmbedding(tag);
          tagEmbeddingsCache.set(tag, embedding); // Cache for future use
          generatedCount++;
          if (generatedCount % 10 === 0) {
            console.log(`[Embeddings] Generated ${generatedCount} new tag embeddings (${i + 1}/${totalTags} total)`);
          }
        } catch (error) {
          console.error(`[Embeddings] Error generating embedding for tag "${tag}":`, error);
          continue; // Skip this tag if embedding fails
        }
      }
      
      tagEmbeddings.push({ tag, embedding });
    }

    console.log(`[Embeddings] Completed processing all tags: ${cachedCount} cached, ${generatedCount} generated, ${tagEmbeddings.length} total`);
    console.log(`[Embeddings] Calculating similarity scores...`);

    // Calculate similarity scores
    const similarities = tagEmbeddings
      .map(({ tag, embedding }) => ({
        tag,
        similarity: cosineSimilarity(textEmbedding, embedding),
      }))
      .filter(item => item.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    console.log(`[Embeddings] Found ${similarities.length} matching tags (top ${topK} with similarity >= ${minSimilarity})`);
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
 * Extract tags from job description using LLM
 * Extracts skills, languages, frameworks, tools, location, job type, etc. directly from the job description
 */
export async function extractTagsFromJob(job) {
  try {
    // Import callLLM dynamically to avoid circular dependency
    const { callLLM } = await import('./llm.js');
    const { parseJsonSafely } = await import('./parseJsonSafely.js');

    console.log('[Tag Extraction] Extracting tags from job description using LLM...');
    
    // Call LLM to extract tags
    const rawResponse = await callLLM('TAG_EXTRACTION', { job });
    const parsed = parseJsonSafely(rawResponse);

    if (!parsed.ok) {
      console.error('[Tag Extraction] Failed to parse LLM response:', parsed.error);
      // Fallback to basic tags from job fields
      return extractBasicTagsFromJob(job);
    }

    // Extract tags from LLM response
    let tags = [];
    
    if (parsed.json.tags && Array.isArray(parsed.json.tags)) {
      tags = parsed.json.tags;
    } else if (parsed.json.categories) {
      // If tags are in categories, flatten them
      const categories = parsed.json.categories;
      tags = [
        ...(categories.languages || []),
        ...(categories.frameworks || []),
        ...(categories.tools || []),
        ...(categories.skills || []),
        ...(categories.location || []),
        ...(categories.job_type || []),
        ...(categories.domain || []),
      ];
    }

    // Normalize and deduplicate tags
    tags = tags
      .map(tag => normalizeTagName(tag.trim()))
      .filter(tag => tag && tag.length > 0);

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

    // Always add explicit skills from job if not already included
    const allSkills = [
      ...(job.must_have_skills || []),
      ...(job.nice_to_have || []),
    ];

    allSkills.forEach(skill => {
      const normalizedSkill = normalizeTagName(skill.trim());
      const lower = normalizedSkill.toLowerCase();
      if (normalizedSkill && !seen.has(lower)) {
        seen.add(lower);
        uniqueTags.push(normalizedSkill);
      }
    });

    console.log(`[Tag Extraction] Extracted ${uniqueTags.length} unique tags from job description`);
    return uniqueTags;
  } catch (error) {
    console.error('[Tag Extraction] Error extracting tags using LLM:', error);
    // Fallback to basic tags from job fields
    return extractBasicTagsFromJob(job);
  }
}

/**
 * Fallback function to extract basic tags from job fields when LLM extraction fails
 */
function extractBasicTagsFromJob(job) {
  const tags = [];
  
  // Add explicit skills
  if (job.must_have_skills) {
    tags.push(...job.must_have_skills.map(s => normalizeTagName(s.trim())));
  }
  if (job.nice_to_have) {
    tags.push(...job.nice_to_have.map(s => normalizeTagName(s.trim())));
  }
  
  // Add role and seniority
  if (job.role) {
    tags.push(normalizeTagName(job.role));
  }
  if (job.seniority) {
    tags.push(normalizeTagName(job.seniority));
  }
  
  // Add location if available
  if (job.location) {
    tags.push(normalizeTagName(job.location));
  }
  
  // Add job type if available
  if (job.job_type) {
    tags.push(normalizeTagName(job.job_type));
  }
  
  // Add team if available
  if (job.team) {
    tags.push(normalizeTagName(job.team));
  }
  
  // Remove duplicates
  return [...new Set(tags.filter(t => t && t.length > 0))];
}

/**
 * Extract tags from resume text using LLM
 * Extracts skills, languages, frameworks, tools, etc. directly from the resume
 */
export async function extractTagsFromResume(resumeText) {
  try {
    if (!resumeText || resumeText.trim().length === 0) {
      return [];
    }

    // Import callLLM dynamically to avoid circular dependency
    const { callLLM } = await import('./llm.js');
    const { parseJsonSafely } = await import('./parseJsonSafely.js');

    console.log('[Resume Tag Extraction] Extracting tags from resume using LLM...');
    
    // Truncate resume text if too long (LLM context limits)
    const maxLength = 8000; // Keep reasonable length for LLM
    const truncatedResume = resumeText.length > maxLength 
      ? resumeText.substring(0, maxLength) + '...'
      : resumeText;
    
    // Call LLM to extract tags
    const rawResponse = await callLLM('RESUME_TAG_EXTRACTION', { resumeText: truncatedResume });
    const parsed = parseJsonSafely(rawResponse);

    if (!parsed.ok) {
      console.error('[Resume Tag Extraction] Failed to parse LLM response:', parsed.error);
      return [];
    }

    // Extract tags from LLM response
    let tags = [];
    
    if (parsed.json.tags && Array.isArray(parsed.json.tags)) {
      tags = parsed.json.tags;
    } else if (parsed.json.categories) {
      // If tags are in categories, flatten them
      const categories = parsed.json.categories;
      tags = [
        ...(categories.languages || []),
        ...(categories.frameworks || []),
        ...(categories.tools || []),
        ...(categories.skills || []),
        ...(categories.domain || []),
        ...(categories.certifications || []),
      ];
    }

    // Normalize and deduplicate tags
    tags = tags
      .map(tag => normalizeTagName(tag.trim()))
      .filter(tag => tag && tag.length > 0);

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

    console.log(`[Resume Tag Extraction] Extracted ${uniqueTags.length} unique tags from resume`);
    return uniqueTags;
  } catch (error) {
    console.error('[Resume Tag Extraction] Error extracting tags using LLM:', error);
    return [];
  }
}

