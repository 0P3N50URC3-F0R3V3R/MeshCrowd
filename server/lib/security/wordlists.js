'use strict';

// Short, common words, a-z only, so they are easy to read in a distorted picture. Hungarian
// words are written without accents because the picture only has plain letters.
const EN = `apple arrow beach bear bell bird boat book bread brick bridge brush cabin cable camel candle carpet castle chair cheese cherry cloud clock coast comet cookie coral cotton crane crown daisy desert dragon dream drum eagle earth engine fabric falcon feather fence field flame flower forest fox garden ghost glass globe grape grass guitar hammer harbor hat heart hill honey horse house island jacket jelly jungle kettle kitten ladder lake lamp lemon letter library lion lunch magnet maple marble meadow melon mirror monkey moon mountain mouse music needle nest ocean olive orange otter paddle panda paper parrot pearl pencil pepper piano pillow pirate planet pocket pond potato puzzle rabbit radio rainbow river robot rocket saddle sailor salad shadow sheep shell silver snow spider spoon star storm sugar summer sunset table tiger tomato tower train tulip turtle valley velvet violin walnut water whale wheel window winter wizard yellow zebra`.split(/\s+/);

const HU = `alma asztal auto bator bicikli birka bokor cica citrom csillag csiga cukor delfin dinnye eger eper erdo esernyo fa farkas felho fenyo fecske fonal fuszer gomba gyertya gyumolcs hajo halo hangya haz hegy hold homok horog hid jegesmedve kavics kenyer kerek kerekpar kert kincs kiraly kocsi konyv korte kutya labda lampa lepke liliom macska madar malom maki medve mezo mókus nap narancs nyul oroszlan ora ozike palack papir pillango pinty pok patak repa rozsa sapka sarkany sas szamar szel szilva szekfu tavasz teknos tenger toll torony tuzijatek tukor ujj uveg vadmacska viola vihar virag vonat zebra zsiraf`.split(/\s+/)
  .map((w) => w.normalize('NFD').replace(/[̀-ͯ]/g, ''))
  .filter((w) => /^[a-z]{3,12}$/.test(w));

module.exports = { EN, HU };
