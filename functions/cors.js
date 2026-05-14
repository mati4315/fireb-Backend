const admin = require('firebase-admin');

// Inicializa la app con credenciales predeterminadas, asumiendo que estamos en entorno local con GOOGLE_APPLICATION_CREDENTIALS
// O puedes usar app default si ya has hecho `firebase login`.
admin.initializeApp({
  storageBucket: 'cdeluar-ddefc-storage'
});

async function configureCors() {
  const bucket = admin.storage().bucket();
  console.log('Configurando CORS para el bucket...', bucket.name);
  
  await bucket.setCorsConfiguration([
    {
      origin: ['*'],
      method: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'OPTIONS'],
      maxAgeSeconds: 3600,
      responseHeader: ['*']
    }
  ]);

  console.log('CORS configurado exitosamente.');
  process.exit(0);
}

configureCors().catch(console.error);
