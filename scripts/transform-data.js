const fs = require('fs');

async function transformData() {
  if (!fs.existsSync('./transformed')) {
    fs.mkdirSync('./transformed');
  }

  // Leer datos exportados
  const users = JSON.parse(fs.readFileSync('./exports/users.json'));
  const content = JSON.parse(fs.readFileSync('./exports/feed.json'));
  // const likes = JSON.parse(fs.readFileSync('./exports/feed_likes.json'));

  // Transformar a estructura Firestore
  const transformedUsers = users.map(user => ({
    id: user.id,
    nombre: user.nombre,
    email: user.email,
    username: user.username,
    rol: user.rol || 'user',
    bio: user.bio || '',
    location: user.location || '',
    website: user.website || '',
    profilePictureUrl: user.profile_picture_url || '',
    isVerified: user.is_verified === 1,
    createdAt: new Date(user.created_at),
    updatedAt: new Date(user.updated_at),
    stats: {
      postsCount: 0,  // Recomputed by Cloud Function
      followersCount: 0,
      followingCount: 0,
      likesTotalCount: 0
    }
  }));

  // Guardar transformados
  fs.writeFileSync(
    './transformed/users.json',
    JSON.stringify(transformedUsers, null, 2)
  );

  console.log('Data transformation complete: users.json');
}

transformData().catch(err => {
  console.error("Transformation failed:", err);
  process.exit(1);
});
