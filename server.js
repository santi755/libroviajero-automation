const express = require('express');
const { createCanvas, loadImage, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { IgApiClient } = require('instagram-private-api');
const cron = require('node-cron');

// Configurar Express (requerido por Render)
const app = express();
const PORT = process.env.PORT || 3000;

// Config
const config = {
  outputDir: 'posts_generados',
  logoPath: 'logo.png',
  fontPath: 'arialbd.ttf',
  igUsername: process.env.IG_USERNAME,
  igPassword: process.env.IG_PASSWORD,
  csvPath: 'frases.csv'
};

// Validar variables de entorno
if (!config.igUsername || !config.igPassword) {
  console.warn('⚠️  Faltan credenciales de Instagram. Configura IG_USERNAME e IG_PASSWORD');
}

// Crear directorio si no existe
if (!fs.existsSync(config.outputDir)) {
  fs.mkdirSync(config.outputDir, { recursive: true });
}

// ========== FUNCIONES DEL BOT ==========

function wrapText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  const lines = [];
  
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = context.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      lines.push(line);
      line = words[n] + ' ';
    } else {
      line = testLine;
    }
  }
  lines.push(line);
  
  lines.forEach((line, i) => {
    context.fillText(line.trim(), x, y + (i * lineHeight));
  });
  
  return lines.length * lineHeight;
}

async function generateImages() {
  return new Promise((resolve, reject) => {
    const results = [];
    
    if (!fs.existsSync(config.csvPath)) {
      reject(new Error(`CSV no encontrado: ${config.csvPath}`));
      return;
    }
    
    fs.createReadStream(config.csvPath)
      .pipe(csv())
      .on('data', (row) => results.push(row))
      .on('end', async () => {
        console.log(`📝 Procesando ${results.length} frases...`);
        
        const imagePromises = results.map(async (row, index) => {
          try {
            const phrase = row.Frase ? row.Frase.toUpperCase() : '';
            const hashtag = row.Hashtag || '';
            const footer = row.Footer || '';
            
            if (!phrase) {
              console.warn(`Fila ${index + 1}: Frase vacía, saltando...`);
              return null;
            }
            
            const canvas = createCanvas(1080, 1080);
            const ctx = canvas.getContext('2d');
            
            ctx.fillStyle = '#f5f1e9';
            ctx.fillRect(0, 0, 1080, 1080);
            
            if (fs.existsSync(config.logoPath)) {
              const logo = await loadImage(config.logoPath);
              const logoX = (1080 - logo.width) / 2;
              ctx.drawImage(logo, logoX, 100);
            }
            
            if (fs.existsSync(config.fontPath)) {
              registerFont(config.fontPath, { family: 'ArialBold' });
              ctx.font = '60px "ArialBold"';
            } else {
              ctx.font = 'bold 60px Arial';
            }
            
            ctx.fillStyle = '#8b4513';
            ctx.textAlign = 'center';
            const phraseHeight = wrapText(ctx, phrase, 540, 300, 800, 70);
            
            ctx.font = 'bold 50px Arial';
            ctx.fillText(hashtag, 540, 300 + phraseHeight + 50);
            
            ctx.font = 'bold 30px Arial';
            ctx.fillText(footer, 540, 300 + phraseHeight + 150);
            
            const buffer = canvas.toBuffer('image/jpeg', { quality: 0.95 });
            const sanitizedName = phrase.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_');
            const filename = path.join(config.outputDir, `${index + 1}_${sanitizedName}.jpg`);
            
            fs.writeFileSync(filename, buffer);
            console.log(`✓ Generado: ${path.basename(filename)}`);
            
            return filename;
          } catch (err) {
            console.error(`Error generando imagen ${index + 1}:`, err.message);
            return null;
          }
        });
        
        const generatedImages = await Promise.all(imagePromises);
        const validImages = generatedImages.filter(img => img !== null);
        
        console.log(`✅ ${validImages.length} imágenes generadas`);
        resolve(validImages);
      })
      .on('error', reject);
  });
}

async function postToInstagram(imagePath, caption) {
  if (!config.igUsername || !config.igPassword) {
    console.error('❌ Credenciales de Instagram no configuradas');
    return false;
  }

  try {
    const ig = new IgApiClient();
    ig.state.generateDevice(config.igUsername);
    
    console.log('🔐 Iniciando sesión en Instagram...');
    await ig.account.login(config.igUsername, config.igPassword);
    
    const imageBuffer = fs.readFileSync(imagePath);
    
    await ig.publish.photo({
      file: imageBuffer,
      caption: caption,
    });
    
    console.log(`✅ Posteado: ${path.basename(imagePath)}`);
    return true;
  } catch (error) {
    console.error('❌ Error posteando:', error.message);
    return false;
  }
}

function getNextImage() {
  const images = fs.readdirSync(config.outputDir)
    .filter(file => file.endsWith('.jpg'))
    .map(file => path.join(config.outputDir, file));
  
  if (images.length === 0) {
    throw new Error('No hay imágenes generadas');
  }
  
  images.sort();
  return images[0];
}

// ========== RUTAS EXPRESS ==========

app.get('/', (req, res) => {
  const stats = {
    status: 'running',
    imagesGenerated: fs.existsSync(config.outputDir) 
      ? fs.readdirSync(config.outputDir).filter(f => f.endsWith('.jpg')).length 
      : 0,
    nextPost: 'Diariamente a las 8:00 AM UTC',
    credentials: config.igUsername ? 'Configuradas ✓' : 'Faltantes ✗'
  };
  
  res.json(stats);
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

app.get('/generate', async (req, res) => {
  try {
    await generateImages();
    res.json({ success: true, message: 'Imágenes generadas' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== CRON JOB ==========

// Ejecutar todos los días a las 8:00 AM UTC
cron.schedule('0 8 * * *', async () => {
  console.log('\n⏰ Tarea programada iniciada');
  try {
    const imagePath = getNextImage();
    const caption = 'Frase del día #SISoy #LibroViajero';
    await postToInstagram(imagePath, caption);
  } catch (error) {
    console.error('Error en cron:', error.message);
  }
});

// ========== INICIAR SERVIDOR ==========

async function init() {
  console.log('🚀 Instagram Bot iniciando...\n');
  
  // Generar imágenes al inicio
  if (fs.existsSync(config.csvPath)) {
    try {
      await generateImages();
    } catch (error) {
      console.error('Error generando imágenes:', error.message);
    }
  } else {
    console.warn('⚠️  frases.csv no encontrado');
  }
  
  // Iniciar servidor HTTP
  app.listen(PORT, () => {
    console.log(`\n✅ Servidor corriendo en puerto ${PORT}`);
    console.log('📅 Cron job activo: Publicación diaria a las 8:00 AM UTC');
  });
}

init().catch(console.error);